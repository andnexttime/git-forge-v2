// The forge's store: repositories, refs, objects, issues, pull requests, labels and comments,
// plus the REST v3 shapes the suite reads. All state is in memory and deterministic: every
// timestamp is fixed (FIXED_ISO) and every server-made commit uses COMMIT_EPOCH + a counter, so
// two runs that receive the same requests produce the same objects, ids and SHAs.
//
// The scenario's viewer (the login the bearer token names) is adaiversen; the stranger is
// olgabauer. Those logins come from wire.ts's fixed SCENARIO_SEED and never change.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjectMap,
} from './git.ts';

export const VIEWER = 'adaiversen';
export const VIEWER_ID = 1000;
export const STRANGER = 'olgabauer';
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const COMMIT_EPOCH = 1_700_000_000;
const AUTHOR = `${VIEWER} <${VIEWER}@example.invalid>`;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: ObjectMap;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export interface Store {
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjectId: number;
  commitSeq: number;
}

export function createStore(): Store {
  return { repos: new Map(), nextRepoId: 1, nextObjectId: 1, commitSeq: 0 };
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

// --------------------------------------------------------------------------- global ids

/** An opaque Relay-style global id: base64 of `Kind:key`. */
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGid(repo: Repo): string {
  return gid('Repository', repoKey(repo.owner, repo.name));
}

export function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', `${repoKey(repo.owner, repo.name)}:${issue.number}`);
}

export function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', `${repoKey(repo.owner, repo.name)}:${pull.number}`);
}

export function commentGid(repo: Repo, issue: Issue, comment: Comment): string {
  return gid('IssueComment', `${repoKey(repo.owner, repo.name)}:${issue.number}:${comment.id}`);
}

// --------------------------------------------------------------------------- repos

export type StoreError = { error: string; status: number };

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER) return undefined;
  return store.repos.get(repoKey(owner, name));
}

export function createRepo(store: Store, name: string, isPrivate: boolean, description: string): { repo: Repo } | StoreError {
  if (typeof name !== 'string' || name.length === 0 || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { error: 'name is not a valid repository name', status: 422 };
  }
  if (store.repos.has(repoKey(VIEWER, name))) return { error: 'Repository already exists', status: 422 };
  const repo: Repo = {
    id: store.nextRepoId++,
    owner: VIEWER,
    name,
    description: description ?? '',
    isPrivate: isPrivate ?? false,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    seq: 0,
  };
  store.repos.set(repoKey(VIEWER, name), repo);
  return { repo };
}

export function deleteRepo(store: Store, owner: string, name: string): boolean {
  if (owner !== VIEWER) return false;
  return store.repos.delete(repoKey(owner, name));
}

export function listRepos(store: Store): Repo[] {
  return [...store.repos.values()];
}

// --------------------------------------------------------------------------- refs and objects

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function setRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
}

export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/** Make a server-side commit (contents PUT, squash merge) with a deterministic timestamp. */
export function makeCommit(store: Store, repo: Repo, parents: string[], tree: string, message: string): string {
  const timestamp = COMMIT_EPOCH + store.commitSeq++;
  const data = buildCommit({ tree, parents, message, author: AUTHOR, committer: AUTHOR, timestamp });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** Store an object, returning its oid. */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
}

/**
 * Set (or delete, when blobOid is null) one path in a tree, returning the new tree oid.
 * Intermediate trees are created as needed; emptied subtrees are pruned.
 */
export function setPath(repo: Repo, treeOid: string | null, parts: readonly string[], blobOid: string | null): string {
  const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = parts as [string, ...string[]];
  const idx = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '100644', name: head, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    const sub = idx >= 0 && entries[idx]?.mode === '40000' ? entries[idx]?.oid ?? null : null;
    const next = setPath(repo, sub, rest, blobOid);
    const nextEntries = parseTree(repo.objects.get(next)?.data ?? Buffer.alloc(0));
    if (nextEntries.length === 0 && blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, oid: next };
    } else {
      entries.push({ mode: '40000', name: head, oid: next });
    }
  }
  return putObject(repo, 'tree', buildTree(entries));
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Resolve a ref name, branch name or oid to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return refTip(repo, `refs/heads/${repo.defaultBranch}`) ?? null;
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  return null;
}

// --------------------------------------------------------------------------- contents

export interface ContentPutResult {
  commitSha: string;
  contentSha: string;
  created: boolean;
}

export function putContent(
  store: Store,
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
  branch: string | undefined,
  sha: string | undefined,
): ContentPutResult | StoreError {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
  if (parts.length === 0) return { error: 'path is empty', status: 422 };
  const branchName = branch ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branchName}`);
  if (tip === undefined) {
    // A branch that does not exist yet is created from the default branch tip (or from nothing
    // when the repository is unborn).
    if (branch !== undefined && branch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
  }
  const baseTree = tip === undefined ? null : commitTree(repo, tip);
  const files = baseTree === null ? new Map() : flattenTree(repo.objects, baseTree);
  const existing = files.get(path);
  if (sha !== undefined) {
    if (existing === undefined) return { error: 'file does not exist', status: 404 };
    if (existing.oid.toLowerCase() !== sha.toLowerCase()) return { error: 'sha does not match the current file', status: 409 };
  } else if (existing !== undefined) {
    return { error: "sha wasn't supplied", status: 422 };
  }
  const blobOid = putObject(repo, 'blob', content);
  const treeOid = setPath(repo, baseTree, parts, blobOid);
  const parents = tip === undefined ? [] : [tip];
  const commitOid = makeCommit(store, repo, parents, treeOid, message);
  repo.refs.set(`refs/heads/${branchName}`, commitOid);
  return { commitSha: commitOid, contentSha: blobOid, created: existing === undefined };
}

export type ContentGetResult =
  | { kind: 'file'; sha: string; content: Buffer; size: number; name: string; path: string }
  | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> }
  | StoreError;

export function getContent(repo: Repo, path: string, ref: string | undefined): ContentGetResult {
  const tip = resolveRef(repo, ref);
  if (tip === null) return { error: 'Not Found', status: 404 };
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return { error: 'Not Found', status: 404 };
  const parts = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
  const files = flattenTree(repo.objects, treeOid);
  const direct = files.get(path);
  if (direct !== undefined) {
    const object = repo.objects.get(direct.oid);
    if (object === undefined) return { error: 'Not Found', status: 404 };
    return { kind: 'file', sha: direct.oid, content: object.data, size: object.data.length, name: parts[parts.length - 1] ?? path, path };
  }
  // A directory: every file under `path/` plus the immediate subdirectories.
  const prefix = parts.length === 0 ? '' : `${path}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  for (const [filePath, file] of files) {
    if (prefix !== '' && !filePath.startsWith(prefix)) continue;
    const rest = prefix === '' ? filePath : filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', name: rest, path: filePath, sha: file.oid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        // The subtree oid: walk the tree to this directory.
        const dirOid = subtreeOid(repo, treeOid, prefix === '' ? dirName : `${path}/${dirName}`) ?? ZERO_OID;
        entries.set(dirName, { type: 'dir', name: dirName, path: prefix === '' ? dirName : `${path}/${dirName}`, sha: dirOid });
      }
    }
  }
  if (entries.size === 0) return { error: 'Not Found', status: 404 };
  const sorted = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return { kind: 'dir', entries: sorted };
}

function subtreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter((part) => part !== '');
  let current: string | null = treeOid;
  for (const part of parts) {
    if (current === null) return null;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((item) => item.name === part && item.mode === '40000');
    current = entry?.oid ?? null;
  }
  return current;
}

export function deleteContent(store: Store, repo: Repo, path: string, message: string, sha: string | undefined, branch: string | undefined): { commitSha: string } | StoreError {
  const branchName = branch ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branchName}`);
  if (tip === undefined) return { error: 'Not Found', status: 404 };
  const baseTree = commitTree(repo, tip);
  if (baseTree === null) return { error: 'Not Found', status: 404 };
  const files = flattenTree(repo.objects, baseTree);
  const existing = files.get(path);
  if (existing === undefined) return { error: 'Not Found', status: 404 };
  if (sha !== undefined && existing.oid.toLowerCase() !== sha.toLowerCase()) return { error: 'sha does not match the current file', status: 409 };
  const parts = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
  const treeOid = setPath(repo, baseTree, parts, null);
  const commitOid = makeCommit(store, repo, [tip], treeOid, message);
  repo.refs.set(`refs/heads/${branchName}`, commitOid);
  return { commitSha: commitOid };
}

// --------------------------------------------------------------------------- branches and commits

export function createBranch(repo: Repo, ref: string, sha: string): { ref: string; sha: string } | StoreError {
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return { error: 'ref must start with refs/heads/ or refs/tags/', status: 422 };
  if (!isObjectId(sha) || !repo.objects.has(sha)) return { error: 'object does not exist', status: 422 };
  if (repo.refs.has(ref)) return { error: 'Reference already exists', status: 422 };
  repo.refs.set(ref, sha);
  return { ref, sha };
}

export function listCommits(repo: Repo, ref: string | undefined): Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> {
  const tip = resolveRef(repo, ref);
  if (tip === null) return [];
  const out: Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  const found: Array<{ sha: string; info: ReturnType<typeof parseCommit> }> = [];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    found.push({ sha: oid, info });
    for (const parent of info.parents) stack.push(parent);
  }
  found.sort((a, b) => b.info.timestamp - a.info.timestamp);
  for (const entry of found) {
    out.push({ sha: entry.sha, message: entry.info.message, author: entry.info.author, committer: entry.info.committer, timestamp: entry.info.timestamp });
  }
  return out;
}

// --------------------------------------------------------------------------- labels and issues

export function createLabel(repo: Repo, name: string, color: string): Label {
  const existing = repo.labels.get(name);
  if (existing !== undefined) return existing;
  const label: Label = { name, color: color ?? 'ededed' };
  repo.labels.set(name, label);
  return label;
}

export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: readonly string[] | undefined): { issue: Issue } | StoreError {
  const names = labels ?? [];
  for (const name of names) {
    if (!repo.labels.has(name)) return { error: `label ${name} does not exist`, status: 422 };
  }
  const issue: Issue = {
    id: store.nextObjectId++,
    number: repo.nextNumber++,
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    labels: [...names],
    comments: [],
    seq: repo.seq++,
  };
  repo.issues.push(issue);
  return { issue };
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

export function listIssues(
  repo: Repo,
  options: { state?: string; sort?: string; direction?: string; page?: number; perPage?: number },
): Issue[] {
  const state = options.state ?? 'open';
  let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
  const direction = (options.direction ?? 'desc').toLowerCase();
  list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
  const page = Math.max(1, options.page ?? 1);
  return list.slice((page - 1) * perPage, page * perPage);
}

export function addComment(repo: Repo, number: number, body: string): { comment: Comment } | StoreError {
  const issue = getIssue(repo, number);
  if (issue === undefined) return { error: 'Not Found', status: 404 };
  const comment: Comment = { id: repo.nextCommentId++, body: body ?? '' };
  issue.comments.push(comment);
  return { comment };
}

// --------------------------------------------------------------------------- pull requests

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldCount = count(oldLines);
  const newCount = count(newLines);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCount) additions += Math.max(0, n - (oldCount.get(line) ?? 0));
  for (const [line, n] of oldCount) deletions += Math.max(0, n - (newCount.get(line) ?? 0));
  return { additions, deletions };
}

export function createPull(store: Store, repo: Repo, title: string, body: string, head: string, base: string): { pull: Pull } | StoreError {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return { error: `head branch ${head} does not exist`, status: 422 };
  if (baseSha === undefined) return { error: `base branch ${base} does not exist`, status: 422 };
  const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
  if (existing !== undefined) return { error: 'A pull request already exists for this head and base', status: 422 };
  const pull: Pull = {
    id: store.nextObjectId++,
    number: repo.nextNumber++,
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headShaAtCreate: headSha,
    baseShaAtCreate: baseSha,
    seq: repo.seq++,
  };
  repo.pulls.push(pull);
  return { pull };
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

export function listPulls(repo: Repo, options: { state?: string; page?: number; perPage?: number }): Pull[] {
  const state = options.state ?? 'open';
  const list = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
  const sorted = [...list].sort((a, b) => b.seq - a.seq);
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
  const page = Math.max(1, options.page ?? 1);
  return sorted.slice((page - 1) * perPage, page * perPage);
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The files a pull request changes, diffed from its merge-base to its head. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  const mb = mergeBase(repo.objects, headSha, baseSha) ?? baseSha;
  const mbTree = commitTree(repo, mb);
  const headTree = commitTree(repo, headSha);
  if (mbTree === null || headTree === null) return [];
  const mbFiles = flattenTree(repo.objects, mbTree);
  const headFiles = flattenTree(repo.objects, headTree);
  const out: PullFile[] = [];
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = mbFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before === undefined ? '' : (repo.objects.get(before.oid)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.objects.get(after.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    out.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export function pullMergeable(repo: Repo, pull: Pull): Mergeable {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  const mb = mergeBase(repo.objects, headSha, baseSha);
  if (mb === null) return 'CONFLICTING';
  const mbTree = commitTree(repo, mb);
  const headTree = commitTree(repo, headSha);
  const baseTree = commitTree(repo, baseSha);
  if (mbTree === null || headTree === null || baseTree === null) return 'CONFLICTING';
  const mbFiles = flattenTree(repo.objects, mbTree);
  const headFiles = flattenTree(repo.objects, headTree);
  const baseFiles = flattenTree(repo.objects, baseTree);
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const mbOid = mbFiles.get(path)?.oid;
    const headOid = headFiles.get(path)?.oid;
    const baseOid = baseFiles.get(path)?.oid;
    if (headOid === mbOid) continue;
    if (baseOid !== mbOid && baseOid !== headOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

export function mergePull(store: Store, repo: Repo, pull: Pull): { sha: string; message: string } | StoreError {
  if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
  if (pullMergeable(repo, pull) !== 'MERGEABLE') return { error: 'Merge conflict', status: 405 };
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  const mb = mergeBase(repo.objects, headSha, baseSha) ?? baseSha;
  const mbTree = commitTree(repo, mb);
  const headTree = commitTree(repo, headSha);
  const baseTree = commitTree(repo, baseSha);
  if (mbTree === null || headTree === null || baseTree === null) return { error: 'Merge conflict', status: 405 };
  const mbFiles = flattenTree(repo.objects, mbTree);
  const headFiles = flattenTree(repo.objects, headTree);
  const baseFiles = flattenTree(repo.objects, baseTree);
  const merged = new Map(baseFiles);
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const mbOid = mbFiles.get(path)?.oid;
    const headOid = headFiles.get(path)?.oid;
    if (headOid === mbOid) continue;
    if (headOid === undefined) merged.delete(path);
    else merged.set(path, headFiles.get(path) as { oid: string; mode: string });
  }
  // Rebuild the tree from the merged file map.
  let treeOid: string | null = null;
  const sorted = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [path, file] of sorted) {
    treeOid = setPath(repo, treeOid, path.split('/'), file.oid);
  }
  if (treeOid === null) treeOid = putObject(repo, 'tree', buildTree([]));
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitOid = makeCommit(store, repo, [baseSha], treeOid, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitOid;
  return { sha: commitOid, message: 'Pull request successfully merged' };
}

// --------------------------------------------------------------------------- REST shapes

function authorOf(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (m === null) return { name: line.trim(), email: '', date: FIXED_ISO };
  return { name: m[1] ?? '', email: m[2] ?? '', date: new Date(Number(m[3]) * 1000).toISOString() };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repoKey(repo.owner, repo.name),
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    node_id: repoGid(repo),
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    node_id: issueGid(repo, issue),
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    node_id: commentGid(repo, issue, comment),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    node_id: pullGid(repo, pull),
  };
}

export function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

export function commitJson(sha: string, message: string, author: string, committer: string, timestamp: number): Record<string, unknown> {
  const a = authorOf(author);
  const c = authorOf(committer);
  return {
    sha,
    commit: {
      message,
      author: a,
      committer: c,
    },
    author: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    parents: [],
  };
}

export function contentFileJson(name: string, path: string, sha: string, content: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha,
  };
}

export function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
  return isAncestor(repo.objects, ancestor, descendant);
}
