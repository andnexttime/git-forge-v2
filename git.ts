// Pure git: object ids, trees, commits, tags, packfiles (read/write, deltas), pkt-lines and the
// reachability walk a fetch needs (wants, haves, shallow boundaries, deepen). No HTTP, no clock,
// no randomness: every byte this module produces is a pure function of its inputs.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectMap = Map<string, GitObject>;

/** SHA-1 hex of bytes. */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Encode tree entries (sorted git-style) into tree bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Decode tree bytes into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Flatten a tree (recursively) into path -> {oid, mode} for files only. */
export function flattenTree(objects: ObjectMap, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

// --------------------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author} ${info.timestamp} +0000`);
  lines.push(`committer ${info.committer} ${info.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) timestamp = Number(m[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer, timestamp };
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
  timestamp: number;
}

export function buildTag(info: TagInfo): Buffer {
  const lines = [
    `object ${info.object}`,
    `type ${info.type}`,
    `tag ${info.tag}`,
    `tagger ${info.tagger} ${info.timestamp} +0000`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  let timestamp = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) {
      tagger = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(tagger);
      if (m) timestamp = Number(m[1]);
    }
  }
  return { object, type, tag, tagger, message, timestamp };
}

// --------------------------------------------------------------------------- pkt-lines

/** One pkt-line framing `payload` (a text line that already ends in \n, or raw bytes). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line payload too large');
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines (request bodies). Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Encode text lines (each ending in \n) plus flush/delim markers into pkt-lines. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(flushPkt());
    else if (line === 'delim') parts.push(delimPkt());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- packfiles

const PACK_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAME: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a pack (version 2, plain objects only, no deltas) with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeNum = PACK_TYPE[object.type];
    const data = object.data;
    // Varint header: low 4 bits of size, then 7 bits per byte, MSB set except on the last.
    let size = data.length;
    const first = (size & 0x0f) | (typeNum << 4) | (size > 15 ? 0x80 : 0);
    const bytes: number[] = [first];
    size >>= 4;
    while (size > 0) {
      bytes.push((size & 0x7f) | (size > 0x7f ? 0x80 : 0));
      size >>= 7;
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer (SHA-1 of everything before it). */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 32) return { ok: false, actual: '', expected: '' };
  const expected = sha1(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, actual, expected };
}

interface DeltaResult {
  data: Buffer;
}

/** Apply a git delta to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[pos++] as number;
      out |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return out;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++] as number;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy');
          offset |= (delta[pos++] as number) << (8 * i);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy');
          size |= (delta[pos++] as number) << (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      chunks.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('truncated delta insert');
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks);
}

export interface ReadPackResult {
  objects: ObjectMap;
  deltaCount: number;
}

/**
 * Read a pack (plain objects and OFS/REF deltas) into an oid -> object map. `resolveBase` answers
 * a REF_DELTA base that is not in the pack itself (a thin pack's base lives in the store).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects: ObjectMap = new Map();
  const byOffset = new Map<number, string>();
  let offset = 12;
  let deltaCount = 0;
  // First pass: plain objects; deltas are resolved after, in offset order (a delta's base always
  // precedes it in the pack, so one pass in order also works — but keep two passes for safety).
  const pending: Array<{ offset: number; typeNum: number; baseOffset?: number; baseOid?: string; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    if (offset >= pack.length - 20) throw new Error('pack truncated');
    let byte = pack[offset++] as number;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= pack.length - 20) throw new Error('pack truncated in size varint');
      byte = pack[offset++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: base offset encoded as a negative offset varint.
      if (offset >= pack.length - 20) throw new Error('pack truncated in ofs-delta');
      byte = pack[offset++] as number;
      let base = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= pack.length - 20) throw new Error('pack truncated in ofs-delta');
        byte = pack[offset++] as number;
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - base;
    } else if (typeNum === 7) {
      // REF_DELTA: base oid, 20 bytes.
      if (offset + 20 > pack.length - 20) throw new Error('pack truncated in ref-delta');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_TYPE_NAME[typeNum] === undefined) {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
    const { data: inflated, consumed } = inflateObject(pack, offset);
    offset += consumed;
    if (inflated.length !== size) throw new Error(`pack object size mismatch: got ${inflated.length}, expected ${size}`);
    if (typeNum === 6 || typeNum === 7) {
      deltaCount += 1;
      pending.push({ offset: start, typeNum, baseOffset, baseOid, data: inflated });
    } else {
      const type = PACK_TYPE_NAME[typeNum] as ObjectType;
      const oid = hashObject(type, inflated);
      objects.set(oid, { type, data: inflated });
      byOffset.set(start, oid);
    }
  }
  // Resolve deltas in pack order; a base is always an earlier object (plain or resolved delta).
  for (const entry of pending) {
    let baseOid: string | undefined;
    let baseType: ObjectType | undefined;
    if (entry.baseOffset !== undefined) {
      baseOid = byOffset.get(entry.baseOffset);
    } else {
      baseOid = entry.baseOid;
    }
    if (baseOid === undefined) throw new Error('delta base not in pack');
    const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
    if (base === undefined) throw new Error('delta base object missing');
    baseType = base.type;
    const data = applyDelta(base.data, entry.data);
    const oid = hashObject(baseType, data);
    objects.set(oid, { type: baseType, data });
    byOffset.set(entry.offset, oid);
  }
  return { objects, deltaCount };
}

/**
 * Whether this Node's inflateSync reports the consumed input length: inflateSync(buf,
 * {info:true}) returns {buffer, engine} with engine.bytesWritten the zlib stream's byte
 * length. When true, one inflate per pack object gives both its data and its end; when
 * false (an older Node), readPack falls back to the probe walk in deflateConsumed.
 * Detected once at load from a known stream, so a wrong answer can never slip through.
 */
const INFLATE_INFO_OK: boolean = (() => {
  try {
    const probe = deflateSync(Buffer.from('probe'));
    const out = inflateSync(probe, { info: true }) as unknown as {
      buffer?: Buffer;
      engine?: { bytesWritten?: unknown };
    };
    return (
      out.buffer !== undefined &&
      out.buffer.length === 5 &&
      typeof out.engine?.bytesWritten === 'number' &&
      out.engine.bytesWritten === probe.length
    );
  } catch {
    return false;
  }
})();

/**
 * Inflate the one zlib stream starting at `offset` (the tail runs to the pack trailer) and
 * report both the object data and how many input bytes the stream consumed. One inflateSync
 * when the runtime reports the length; the probe walk otherwise.
 */
function inflateObject(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  const tail = pack.subarray(offset, pack.length - 20);
  if (INFLATE_INFO_OK) {
    const out = inflateSync(tail, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    return { data: out.buffer, consumed: out.engine.bytesWritten };
  }
  const data = inflateSync(tail);
  return { data, consumed: deflateConsumed(pack, offset, data.length) };
}

/**
 * How many bytes of `pack` starting at `offset` the zlib stream consumes. Node's inflateSync
 * returns the first complete stream and ignores trailing bytes (and throws on a truncated one),
 * so the consumed length is the smallest end that inflates to `expectedSize`: find it by an
 * exponential probe (the stream is at most ~2x its output for the small objects this forge moves)
 * and then a binary search inside the last doubling interval.
 * Fallback only: inflateObject uses the one-call {info:true} path when the runtime has it.
 */
function deflateConsumed(pack: Buffer, offset: number, expectedSize: number): number {
  const limit = pack.length - 20;
  const works = (end: number): boolean => {
    if (end <= offset) return false;
    try {
      return inflateSync(pack.subarray(offset, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  let lo = offset;
  let step = 32;
  let hi = offset + step;
  while (hi < limit && !works(hi)) {
    lo = hi;
    step *= 2;
    hi = offset + step;
  }
  if (hi > limit) hi = limit;
  if (!works(hi)) throw new Error('pack object deflate stream does not terminate');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (works(mid)) hi = mid;
    else lo = mid;
  }
  return hi - offset;
}

// --------------------------------------------------------------------------- reachability

export interface CollectOptions {
  /** Commits the client already holds in full (ancestors included). */
  haves?: readonly string[];
  /** The client's current shallow boundaries (commit + tree + blobs, but not parents). */
  shallowBoundaries?: readonly string[];
  /** Depth limit: include commits at distance < depth from a want. */
  depth?: number;
}

export interface CollectResult {
  objects: ObjectMap;
  /** New shallow boundaries: commits at distance depth-1 from a want (depth fetches only). */
  shallow: string[];
  /** Old shallow boundaries that are now fully fetched. */
  unshallow: string[];
}

/**
 * The objects a fetch must send for `wants`, honouring haves, the client's shallow boundaries
 * and a depth limit. Commit distances are measured from the wants (0-based).
 */
export function collectObjects(store: ObjectMap, wants: readonly string[], options: CollectOptions = {}): CollectResult {
  const haves = new Set(options.haves ?? []);
  const clientShallow = new Set(options.shallowBoundaries ?? []);
  const depth = options.depth;

  // Commit distances from the wants (BFS over parents), honouring the depth cap.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    if (dist.has(want)) continue;
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      dist.set(want, 0);
      queue.push(want);
    }
  }
  // Tags in the wants resolve to their target commit (the tag itself is sent separately).
  const tagOids: string[] = [];
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagOids.push(want);
      const target = parseTag(object.data).object;
      if (!dist.has(target)) {
        const targetObject = store.get(target);
        if (targetObject !== undefined && targetObject.type === 'commit') {
          dist.set(target, 0);
          queue.push(target);
        }
      }
    }
  }
  const includedCommits = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = dist.get(oid) as number;
    if (depth !== undefined && d >= depth) continue;
    includedCommits.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (dist.has(parent)) continue;
      if (store.get(parent) === undefined) continue;
      dist.set(parent, d + 1);
      queue.push(parent);
    }
  }

  // Exclusions: everything reachable from a have (full history), and the shallow closure of each
  // client boundary (the boundary commit + its tree/blobs, not its parents). A have that is also
  // one of the client's shallow boundaries is NOT a full have: the client holds that commit but
  // not its parents, which is exactly what a deepen asks for — so its parents stay excludable
  // only by the depth cap, never by the have.
  const excluded = new Set<string>();
  const excludeReachable = (root: string, includeParents: boolean): void => {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (excluded.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      excluded.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (includeParents) for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  };
  for (const have of haves) excludeReachable(have, !clientShallow.has(have));
  for (const boundary of clientShallow) excludeReachable(boundary, false);

  const objects: ObjectMap = new Map();
  const addObject = (oid: string): void => {
    if (excluded.has(oid)) return;
    const object = store.get(oid);
    if (object === undefined) return;
    if (objects.has(oid)) return;
    objects.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addObject(commit.tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) addObject(entry.oid);
    } else if (object.type === 'tag') {
      addObject(parseTag(object.data).object);
    }
  };
  for (const oid of includedCommits) addObject(oid);
  for (const oid of tagOids) addObject(oid);
  // A want that is a bare tree/blob (never sent by this suite's client, but harmless to honour).
  for (const want of wants) {
    const object = store.get(want);
    if (object !== undefined && (object.type === 'tree' || object.type === 'blob')) addObject(want);
  }

  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of dist) {
      if (d === depth - 1 && includedCommits.has(oid)) shallow.push(oid);
    }
    shallow.sort();
  }
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!includedCommits.has(boundary)) continue;
    const d = dist.get(boundary);
    if (d === undefined) continue;
    if (depth === undefined || d < depth - 1) unshallow.push(boundary);
  }
  unshallow.sort();
  return { objects, shallow, unshallow };
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(store: ObjectMap, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** All commits reachable from `tip` (including it), newest first by timestamp then discovery. */
export function reachableCommits(store: ObjectMap, tip: string): CommitInfo[] {
  const out: Array<{ oid: string; info: CommitInfo }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    out.push({ oid, info });
    for (const parent of info.parents) stack.push(parent);
  }
  out.sort((a, b) => b.info.timestamp - a.info.timestamp);
  return out.map((entry) => entry.info);
}

/** The merge-base of two commits: the reachable common ancestor with the newest timestamp. */
export function mergeBase(store: ObjectMap, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  let best: string | null = null;
  let bestTs = -1;
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (fromA.has(oid)) {
      const ts = parseCommit(object.data).timestamp;
      if (ts > bestTs) {
        bestTs = ts;
        best = oid;
      }
    }
    for (const parent of parseCommit(object.data).parents) stackB.push(parent);
  }
  return best;
}
