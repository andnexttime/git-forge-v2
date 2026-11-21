// The HTTP server: one Node http server serving git smart HTTP, REST v3, GraphQL v4 and MCP
// from the in-memory store, plus the /healthz boot probe. Standard library only.
//
// Auth: every route except /healthz requires `Authorization: Bearer <token>` where the token is
// MAKEFUN_SHOP_TOKEN when it is set (the trial), or any non-empty bearer token when it is not
// (a local practice run). A missing or wrong token is 401 JSON; a repository under any owner
// other than the token's login is 404, never 403. Every REST reply is application/json with a
// non-empty X-GitHub-Request-Id; errors carry a JSON body with a string message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectObjects,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  flushPkt,
  type GitObject,
} from './git.ts';
import {
  VIEWER,
  addComment,
  branchJson,
  commitJson,
  contentFileJson,
  createBranch,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteContent,
  deleteRepo,
  getContent,
  getIssue,
  getPull,
  getRepo,
  issueJson,
  labelJson,
  listBranches,
  listCommits,
  listIssues,
  listPulls,
  listRepos,
  mergePull,
  pullFiles,
  pullJson,
  putContent,
  repoJson,
  createStore,
  commentJson,
  type Repo,
  type Store,
} from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store: Store = createStore();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;
  /**
   * Memoized fetch packfiles, keyed by the sorted object ids they carry. A pack is a pure
   * function of its object set (objects are content-addressed and never mutated in place), so
   * the same key always means the same bytes — the 50 concurrent depth-1 clones of one tip
   * build the pack once and reuse it 49 times. FIFO-capped; the key, not the store, decides.
   */
  const fetchPackCache = new Map<string, Buffer>();

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const id = `req-${(++requestSeq).toString(16)}`;
    if (status === 204) {
      res.writeHead(204, { 'x-github-request-id': id, ...extra });
      res.end();
      return;
    }
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': id,
      ...extra,
    });
    res.end(text);
  };

  const sendBytes = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
    res.end(body);
  };

  const unauthorized = (res: ServerResponse): void => {
    sendJson(res, 401, { message: 'Requires authentication' });
  };

  const isAuthorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length).trim();
    if (token === '') return false;
    if (expectedToken !== '') return token === expectedToken;
    return true;
  };

  // ---------------------------------------------------------------- git smart HTTP

  const v0CapsUpload = 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=forge/1.0';
  const v0CapsReceive = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0';

  function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
    const caps = service === 'git-upload-pack' ? v0CapsUpload : v0CapsReceive;
    const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
    const mainTip = repo.refs.get('refs/heads/main');
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const headOid = mainTip ?? refs[0]?.[1] ?? ZERO_OID;
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      for (const [name, oid] of refs) {
        parts.push(pktLine(`${oid} ${name}\n`));
        const object = repo.objects.get(oid);
        if (object !== undefined && object.type === 'tag' && name.startsWith('refs/tags/')) {
          const target = parseTag(object.data).object;
          parts.push(pktLine(`${target} ${name}^{}\n`));
        }
      }
    }
    parts.push(flushPkt());
    return Buffer.concat(parts);
  }

  function advertisementV2(): Buffer {
    return encodePktLines(['version 2\n', 'ls-refs\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'flush']);
  }

  function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): void {
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service');
    const repo = getRepo(store, owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'missing service' });
      return;
    }
    if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
      sendBytes(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    sendBytes(res, 200, advertisementV0(repo, service), `application/x-${service}-advertisement`);
  }

  function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
    const repo = getRepo(store, owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    const first = packets.find((packet) => packet.kind === 'data');
    const command = first?.payload.toString('utf8').trim() ?? '';
    if (command === 'command=ls-refs') {
      handleLsRefs(res, repo, packets);
      return;
    }
    if (command === 'command=fetch') {
      handleFetch(res, repo, packets);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
  }

  function handleLsRefs(res: ServerResponse, repo: Repo, packets: ReturnType<typeof decodePktLines>): void {
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    let pastDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind !== 'data' || !pastDelim) continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const lines: string[] = [];
    const mainTip = repo.refs.get('refs/heads/main');
    if (mainTip !== undefined && keep('HEAD')) {
      lines.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [name, oid] of refs) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      const object = repo.objects.get(oid);
      if (peel && object !== undefined && object.type === 'tag' && name.startsWith('refs/tags/')) {
        line += ` peeled:${parseTag(object.data).object}`;
      }
      lines.push(`${line}\n`);
    }
    lines.push('flush');
    sendBytes(res, 200, encodePktLines(lines), 'application/x-git-upload-pack-result');
  }

  function handleFetch(res: ServerResponse, repo: Repo, packets: ReturnType<typeof decodePktLines>): void {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowBoundaries: string[] = [];
    let depth: number | undefined;
    let pastDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind !== 'data' || !pastDelim) continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isInteger(n) && n > 0) depth = n;
      }
    }
    const held = haves.filter((oid) => repo.objects.has(oid));
    const { objects, shallow, unshallow } = collectObjects(repo.objects, wants, {
      haves,
      shallowBoundaries,
      depth,
    });
    const withOid = [...objects.values()].map((object) => ({ oid: hashObject(object.type, object.data), object }));
    withOid.sort((a, b) => (a.oid < b.oid ? -1 : 1));
    const cacheKey = withOid.map((entry) => entry.oid).join(',');
    let pack = fetchPackCache.get(cacheKey);
    if (pack === undefined) {
      pack = writePack(withOid.map((entry) => entry.object));
      fetchPackCache.set(cacheKey, pack);
      if (fetchPackCache.size > 16) {
        const first = fetchPackCache.keys().next().value;
        if (first !== undefined) fetchPackCache.delete(first);
      }
    }
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (held.length > 0) {
      for (const oid of held) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(Buffer.from('0001', 'ascii'));
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(pktLine('packfile\n'));
    const CHUNK = 65515;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(flushPkt());
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }

  function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
    const repo = getRepo(store, owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // Parse pkt-lines from the front until the flush; the remainder is the pack.
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let offset = 0;
    let packStart = -1;
    let malformed = false;
    while (offset < body.length) {
      if (offset + 4 > body.length) {
        malformed = true;
        break;
      }
      const lenText = body.subarray(offset, offset + 4).toString('ascii');
      const len = Number.parseInt(lenText, 16);
      if (!Number.isFinite(len) || len < 0 || len > 65520) {
        malformed = true;
        break;
      }
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      if (len < 4 || offset + len > body.length) {
        malformed = true;
        break;
      }
      const payload = body.subarray(offset + 4, offset + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match === null) {
        malformed = true;
        break;
      }
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      offset += len;
    }
    if (malformed || packStart < 0 || commands.length === 0) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    const pack = body.subarray(packStart);
    const report: string[] = [];
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (needsPack) {
      if (pack.length === 0) {
        unpackOk = false;
        unpackDetail = 'unpack failed: missing pack';
      } else {
        const checksum = verifyPackChecksum(pack);
        if (!checksum.ok) {
          unpackOk = false;
          unpackDetail = 'unpack failed: pack checksum mismatch';
        } else {
          try {
            const read = readPack(pack, (oid) => repo.objects.get(oid));
            for (const [oid, object] of read.objects) repo.objects.set(oid, object);
          } catch (err) {
            unpackOk = false;
            unpackDetail = `unpack failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }
    if (unpackOk) {
      report.push('unpack ok\n');
      for (const command of commands) {
        const current = repo.refs.get(command.ref);
        if (command.newOid === ZERO_OID) {
          if (current === undefined) {
            report.push(`ng ${command.ref} remote ref does not exist\n`);
          } else {
            repo.refs.delete(command.ref);
            report.push(`ok ${command.ref}\n`);
          }
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          report.push(`ng ${command.ref} object not found\n`);
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          if (current !== undefined) {
            report.push(`ng ${command.ref} already exists\n`);
            continue;
          }
          repo.refs.set(command.ref, command.newOid);
          report.push(`ok ${command.ref}\n`);
          continue;
        }
        if (current === undefined) {
          report.push(`ng ${command.ref} remote ref does not exist\n`);
          continue;
        }
        if (current !== command.oldOid) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      }
    } else {
      report.push(`unpack ${unpackDetail.replace(/^unpack /, '')}\n`);
      for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
    }
    const reportBytes = encodePktLines(report);
    const sideband = pktLine(Buffer.concat([Buffer.from([1]), reportBytes]));
    sendBytes(res, 200, Buffer.concat([sideband, flushPkt()]), 'application/x-git-receive-pack-result');
  }

  // ---------------------------------------------------------------- REST v3

  const notFound = (res: ServerResponse): void => sendJson(res, 404, { message: 'Not Found' });

  function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
    if (body.length === 0) return { ok: true, value: {} };
    try {
      const value = JSON.parse(body.toString('utf8')) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
      return { ok: true, value: {} };
    } catch {
      return { ok: false };
    }
  }

  function pageParams(url: URL): { page: number; perPage: number } {
    const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    return { page, perPage };
  }

  function linkHeader(req: IncomingMessage, url: URL, page: number, perPage: number, hasNext: boolean, total: number): string | null {
    if (!hasNext) return null;
    const host = req.headers.host ?? '127.0.0.1';
    const base = `http://${host}${url.pathname}`;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const next = `<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
    const last = `<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`;
    return `${next}, ${last}`;
  }

  async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], url: URL, body: Buffer): Promise<void> {
    const method = req.method ?? 'GET';
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || (method === 'DELETE' && body.length > 0);
    let json: Record<string, unknown> = {};
    if (hasBody) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      json = parsed.value;
    }
    const seg = (index: number): string | undefined => segments[index];

    // GET /api/v3/ — the API root.
    if (segments.length === 0) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // GET /api/v3/meta
    if (segments.length === 1 && seg(0) === 'meta') {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // GET /api/v3/user and /api/v3/user/repos
    if (seg(0) === 'user') {
      if (segments.length === 1) {
        if (method !== 'GET') {
          notFound(res);
          return;
        }
        sendJson(res, 200, { login: VIEWER, id: 1000, type: 'User', name: VIEWER, email: `${VIEWER}@example.invalid` });
        return;
      }
      if (segments.length === 2 && seg(1) === 'repos') {
        if (method === 'GET') {
          const { page, perPage } = pageParams(url);
          const all = listRepos(store);
          const pageItems = all.slice((page - 1) * perPage, page * perPage);
          const hasNext = page * perPage < all.length;
          const link = linkHeader(req, url, page, perPage, hasNext, all.length);
          sendJson(res, 200, pageItems.map((repo) => repoJson(repo)), link === null ? {} : { link });
          return;
        }
        if (method === 'POST') {
          const made = createRepo(store, String(json.name ?? ''), json.private === true, String(json.description ?? ''));
          if ('error' in made) {
            sendJson(res, made.status, { message: made.error });
            return;
          }
          sendJson(res, 201, repoJson(made.repo));
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }

    // /api/v3/repos/{owner}/{repo}[...]
    if (seg(0) === 'repos' && segments.length >= 3) {
      const owner = decodeURIComponent(seg(1) as string);
      const repoName = decodeURIComponent(seg(2) as string);
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) {
        notFound(res);
        return;
      }
      const rest = segments.slice(3);

      // /repos/{o}/{r}
      if (rest.length === 0) {
        if (method === 'GET') {
          sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'PATCH') {
          if (typeof json.description === 'string') repo.description = json.description;
          sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'DELETE') {
          deleteRepo(store, owner, repoName);
          sendJson(res, 204, null);
          return;
        }
        notFound(res);
        return;
      }

      // /repos/{o}/{r}/branches[/{branch}]
      if (rest[0] === 'branches') {
        if (method !== 'GET') {
          notFound(res);
          return;
        }
        if (rest.length === 1) {
          sendJson(res, 200, listBranches(repo).map((branch) => branchJson(branch.name, branch.sha)));
          return;
        }
        const branchName = decodeURIComponent(rest.slice(1).join('/'));
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        if (tip === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, branchJson(branchName, tip));
        return;
      }

      // /repos/{o}/{r}/commits
      if (rest[0] === 'commits') {
        if (method !== 'GET' || rest.length !== 1) {
          notFound(res);
          return;
        }
        const sha = url.searchParams.get('sha') ?? undefined;
        const commits = listCommits(repo, sha);
        const { page, perPage } = pageParams(url);
        const pageItems = commits.slice((page - 1) * perPage, page * perPage);
        sendJson(
          res,
          200,
          pageItems.map((commit) => {
            const out = commitJson(commit.sha, commit.message, commit.author, commit.committer, commit.timestamp);
            return out;
          }),
        );
        return;
      }

      // /repos/{o}/{r}/git/refs[/heads/{branch}|/tags/{tag}]
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (method === 'POST' && rest.length === 2) {
          const ref = String(json.ref ?? '');
          const sha = String(json.sha ?? '');
          const made = createBranch(repo, ref, sha);
          if ('error' in made) {
            sendJson(res, made.status, { message: made.error });
            return;
          }
          sendJson(res, 201, { ref: made.ref, object: { sha: made.sha } });
          return;
        }
        if (method === 'GET' && rest.length >= 4 && (rest[2] === 'heads' || rest[2] === 'tags')) {
          const name = decodeURIComponent(rest.slice(3).join('/'));
          const ref = `refs/${rest[2]}/${name}`;
          const tip = repo.refs.get(ref);
          if (tip === undefined) {
            notFound(res);
            return;
          }
          sendJson(res, 200, { ref, object: { sha: tip } });
          return;
        }
        if (method === 'GET' && rest.length === 2) {
          const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
          sendJson(res, 200, refs);
          return;
        }
        notFound(res);
        return;
      }

      // /repos/{o}/{r}/contents/{path}
      if (rest[0] === 'contents') {
        const filePath = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
        if (method === 'GET') {
          const ref = url.searchParams.get('ref') ?? undefined;
          const result = getContent(repo, filePath, ref);
          if ('error' in result) {
            sendJson(res, result.status, { message: result.error });
            return;
          }
          if (result.kind === 'file') {
            sendJson(res, 200, contentFileJson(result.name, result.path, result.sha, result.content));
            return;
          }
          sendJson(
            res,
            200,
            result.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: 0 })),
          );
          return;
        }
        if (method === 'PUT') {
          const contentB64 = String(json.content ?? '');
          let content: Buffer;
          try {
            content = Buffer.from(contentB64, 'base64');
          } catch {
            sendJson(res, 400, { message: 'content is not valid base64' });
            return;
          }
          const result = putContent(
            store,
            repo,
            filePath,
            content,
            String(json.message ?? ''),
            typeof json.branch === 'string' ? json.branch : undefined,
            typeof json.sha === 'string' ? json.sha : undefined,
          );
          if ('error' in result) {
            sendJson(res, result.status, { message: result.error });
            return;
          }
          sendJson(
            res,
            result.created ? 201 : 200,
            { content: { sha: result.contentSha, encoding: 'base64' }, commit: { sha: result.commitSha } },
          );
          return;
        }
        if (method === 'DELETE') {
          const result = deleteContent(
            store,
            repo,
            filePath,
            String(json.message ?? ''),
            typeof json.sha === 'string' ? json.sha : undefined,
            typeof json.branch === 'string' ? json.branch : undefined,
          );
          if ('error' in result) {
            sendJson(res, result.status, { message: result.error });
            return;
          }
          sendJson(res, 200, { commit: { sha: result.commitSha } });
          return;
        }
        notFound(res);
        return;
      }

      // /repos/{o}/{r}/labels
      if (rest[0] === 'labels') {
        if (method === 'POST' && rest.length === 1) {
          const label = createLabel(repo, String(json.name ?? ''), String(json.color ?? 'ededed'));
          sendJson(res, 201, labelJson(label));
          return;
        }
        if (method === 'GET' && rest.length === 1) {
          sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
          return;
        }
        notFound(res);
        return;
      }

      // /repos/{o}/{r}/issues[/{n}[/comments]]
      if (rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const { page, perPage } = pageParams(url);
            const issues = listIssues(repo, {
              state: url.searchParams.get('state') ?? 'open',
              sort: url.searchParams.get('sort') ?? 'created',
              direction: url.searchParams.get('direction') ?? 'desc',
              page,
              perPage,
            });
            sendJson(res, 200, issues.map((issue) => issueJson(repo, issue)));
            return;
          }
          if (method === 'POST') {
            const labels = Array.isArray(json.labels) ? (json.labels as unknown[]).map((label) => String(label)) : [];
            const made = createIssue(store, repo, String(json.title ?? ''), String(json.body ?? ''), labels);
            if ('error' in made) {
              sendJson(res, made.status, { message: made.error });
              return;
            }
            sendJson(res, 201, issueJson(repo, made.issue));
            return;
          }
          notFound(res);
          return;
        }
        const number = Number(rest[1]);
        if (!Number.isInteger(number) || number < 1) {
          notFound(res);
          return;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            const issue = getIssue(repo, number);
            if (issue === undefined) {
              notFound(res);
              return;
            }
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
          if (method === 'PATCH') {
            const issue = getIssue(repo, number);
            if (issue === undefined) {
              notFound(res);
              return;
            }
            if (json.state === 'open' || json.state === 'closed') issue.state = json.state;
            if (typeof json.title === 'string') issue.title = json.title;
            if (typeof json.body === 'string') issue.body = json.body;
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
          notFound(res);
          return;
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          const issue = getIssue(repo, number);
          if (issue === undefined) {
            notFound(res);
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
            return;
          }
          if (method === 'POST') {
            const made = addComment(repo, number, String(json.body ?? ''));
            if ('error' in made) {
              sendJson(res, made.status, { message: made.error });
              return;
            }
            sendJson(res, 201, commentJson(repo, issue, made.comment));
            return;
          }
          notFound(res);
          return;
        }
        notFound(res);
        return;
      }

      // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
      if (rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const { page, perPage } = pageParams(url);
            const pulls = listPulls(repo, { state: url.searchParams.get('state') ?? 'open', page, perPage });
            sendJson(res, 200, pulls.map((pull) => pullJson(repo, pull)));
            return;
          }
          if (method === 'POST') {
            const made = createPull(store, repo, String(json.title ?? ''), String(json.body ?? ''), String(json.head ?? ''), String(json.base ?? ''));
            if ('error' in made) {
              sendJson(res, made.status, { message: made.error });
              return;
            }
            sendJson(res, 201, pullJson(repo, made.pull));
            return;
          }
          notFound(res);
          return;
        }
        const number = Number(rest[1]);
        if (!Number.isInteger(number) || number < 1) {
          notFound(res);
          return;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            const pull = getPull(repo, number);
            if (pull === undefined) {
              notFound(res);
              return;
            }
            sendJson(res, 200, pullJson(repo, pull));
            return;
          }
          notFound(res);
          return;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const pull = getPull(repo, number);
          if (pull === undefined) {
            notFound(res);
            return;
          }
          sendJson(res, 200, pullFiles(repo, pull));
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const pull = getPull(repo, number);
          if (pull === undefined) {
            notFound(res);
            return;
          }
          const merged = mergePull(store, repo, pull);
          if ('error' in merged) {
            sendJson(res, merged.status, { message: merged.error });
            return;
          }
          sendJson(res, 200, { sha: merged.sha, merged: true, message: merged.message });
          return;
        }
        notFound(res);
        return;
      }

      notFound(res);
      return;
    }

    notFound(res);
  }

  // ---------------------------------------------------------------- the server

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const rawPath = url.pathname;
        const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
        const segments = path.split('/').filter((part) => part !== '');

        if (req.method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isApi = segments[0] === 'api' && segments[1] === 'v3';
        const isGraphql = path === '/api/graphql';
        const isMcp = path === '/mcp';
        const isGit = segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git');

        if (!isApi && !isGraphql && !isMcp && !isGit) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        if (!isAuthorized(req)) {
          unauthorized(res);
          return;
        }

        if (isGit) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const gitPath = segments.slice(2).join('/');
          if (req.method === 'GET' && gitPath === 'info/refs') {
            handleInfoRefs(req, res, owner, repoName);
            return;
          }
          if (req.method === 'POST' && gitPath === 'git-upload-pack') {
            const body = await readBody(req);
            handleUploadPack(req, res, owner, repoName, body);
            return;
          }
          if (req.method === 'POST' && gitPath === 'git-receive-pack') {
            const body = await readBody(req);
            handleReceivePack(req, res, owner, repoName, body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        if (isGraphql) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              const op = (entry ?? {}) as Record<string, unknown>;
              if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'missing query' }] };
              return executeGraphQL(store, op.query, (op.variables ?? {}) as Record<string, unknown>, typeof op.operationName === 'string' ? op.operationName : undefined);
            });
            sendJson(res, 200, results);
            return;
          }
          const op = (parsed ?? {}) as Record<string, unknown>;
          if (typeof op.query !== 'string') {
            sendJson(res, 400, { message: 'missing query' });
            return;
          }
          sendJson(res, 200, executeGraphQL(store, op.query, (op.variables ?? {}) as Record<string, unknown>, typeof op.operationName === 'string' ? op.operationName : undefined));
          return;
        }

        if (isMcp) {
          if (req.method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const outcome = handleMcp(store, body.toString('utf8'));
          if (outcome.body === null) {
            res.writeHead(outcome.status);
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // REST v3.
        const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        await handleRest(req, res, segments.slice(2), url, body);
      } catch (err) {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
          } catch {
            res.destroy();
          }
        } else {
          res.destroy();
        }
      }
    })();
  });

  return server;
}
