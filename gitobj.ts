// gitobj.ts — git objects and packfiles, pure functions, no I/O.
//
// Implements the object model the suite's git client speaks (see spec-git.md):
// SHA-1 object ids, commit/tree/tag/blob formats, packfile v2/v3 reading with
// OFS_DELTA / REF_DELTA resolution, plain packfile writing, reachability,
// tree flattening/diffing, merge-base and ancestry.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjType, PullFile, Store } from './store.ts';
import { FORGE_IDENT } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(s: string): boolean {
  return OID_RE.test(s);
}

/** SHA-1 of `<type> <size>\0<data>`, lowercase hex. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: ObjType, data: Buffer): GitObject {
  return { type, data };
}

// ---------------------------------------------------------------- commits

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Raw extra header lines (e.g. `gpgsig ...`, multi-line values included). */
  extra: string[];
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const lines = head.split('\n');
  const out: CommitParts = { tree: '', parents: [], author: '', committer: '', message, extra: [] };
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith(' ') && current !== null) {
      // Continuation of a multi-line header value.
      out.extra[out.extra.length - 1] += `\n${line}`;
      continue;
    }
    current = null;
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'tree') out.tree = value;
    else if (key === 'parent') out.parents.push(value);
    else if (key === 'author') out.author = value;
    else if (key === 'committer') out.committer = value;
    else {
      out.extra.push(line);
      current = key;
    }
  }
  if (!isOid(out.tree)) throw new Error('commit without a valid tree');
  for (const p of out.parents) {
    if (!isOid(p)) throw new Error('commit with an invalid parent');
  }
  return out;
}

export function buildCommit(p: CommitParts): Buffer {
  const lines: string[] = [`tree ${p.tree}`];
  for (const parent of p.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${p.author}`);
  lines.push(`committer ${p.committer}`);
  for (const e of p.extra) lines.push(e);
  return Buffer.from(`${lines.join('\n')}\n\n${p.message}`, 'utf8');
}

// ------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) throw new Error('tree-parse: truncated entry');
    const mode = data.toString('ascii', off, sp);
    if (!/^[0-7]+$/.test(mode)) throw new Error('tree-parse: bad mode');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('tree-parse: truncated entry');
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** True for a tree (directory) entry mode. Git writes '40000'; some writers pad to '040000'. */
export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git tree sort order: by name bytes, directories compared as if suffixed '/'. */
export function treeSortKey(e: TreeEntry): string {
  return isTreeMode(e.mode) ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------- tags

export interface TagParts {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: TagParts = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'object') out.object = value;
    else if (key === 'type') out.type = value as ObjType;
    else if (key === 'tag') out.tag = value;
    else if (key === 'tagger') out.tagger = value;
  }
  if (!isOid(out.object)) throw new Error('tag without a valid object');
  if (!['commit', 'tree', 'blob', 'tag'].includes(out.type)) throw new Error('tag with a bad type');
  return out;
}

export function buildTag(p: TagParts): Buffer {
  const lines = [`object ${p.object}`, `type ${p.type}`, `tag ${p.tag}`, `tagger ${p.tagger}`];
  return Buffer.from(`${lines.join('\n')}\n\n${p.message}`, 'utf8');
}

// ------------------------------------------------------------------ deltas

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    if (i >= buf.length) throw new Error('delta: truncated varint');
    const b = buf[i];
    i += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to its base buffer. Throws on any corruption. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const src = readVarint(delta, off);
  off = src.next;
  if (src.value !== base.length) throw new Error('delta-base-size');
  const tgt = readVarint(delta, off);
  off = tgt.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (off >= delta.length) throw new Error('delta-corrupt');
          cpOff |= delta[off] << (bit * 8);
          off += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (off >= delta.length) throw new Error('delta-corrupt');
          cpSize |= delta[off] << (bit * 8);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta-corrupt');
      out.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      if (off + op > delta.length) throw new Error('delta-corrupt');
      out.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error('delta-corrupt');
    }
  }
  if (produced !== tgt.value) throw new Error('delta-size');
  return Buffer.concat(out);
}

/**
 * Inflate one zlib stream starting at `off`, knowing the expected output size.
 * Node's inflateSync ignores trailing bytes, so the consumed length is found
 * by binary search for the shortest prefix that inflates to the right size.
 */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; next: number } {
  const max = buf.length - off;
  let lo = 1;
  let hi = max;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(off, off + mid));
      if (out.length === expectedSize) {
        found = mid;
        hi = mid - 1;
      } else if (out.length < expectedSize) {
        lo = mid + 1;
      } else {
        // Longer than expected: the stream cannot be this long; should not happen.
        hi = mid - 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (found === -1) throw new Error('pack-size: cannot inflate entry');
  return { data: inflateSync(buf.subarray(off, off + found)), next: off + found };
}

// --------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, ObjType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

interface RawEntry {
  offset: number;
  kind: number;
  size: number;
  baseOffset?: number;
  baseOid?: string;
  data: Buffer;
}

/** Read a packfile (v2/v3), verify its trailer, resolve all deltas. */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack-truncated');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const computed = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!computed.equals(trailer)) throw new Error('pack-checksum');

  const raws: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    if (off >= buf.length - 20) throw new Error('pack-truncated');
    let b = buf[off];
    off += 1;
    const kind = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (off >= buf.length - 20) throw new Error('pack-truncated');
      b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const typeName = PACK_TYPES[kind];
    if (typeName === undefined) throw new Error('pack-type');
    const entry: RawEntry = { offset: start, kind, size, data: Buffer.alloc(0) };
    if (kind === 6) {
      // OFS_DELTA: offset encoding — value = ((value + 1) << 7) | (byte & 0x7f).
      let byte = buf[off];
      off += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[off];
        off += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = start - value;
      if (entry.baseOffset < 0) throw new Error('pack-delta');
    } else if (kind === 7) {
      if (off + 20 > buf.length - 20) throw new Error('pack-truncated');
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateAt(buf, off, size);
    entry.data = inflated.data;
    off = inflated.next;
    raws.push(entry);
    byOffset.set(start, entry);
  }
  if (off !== buf.length - 20) throw new Error('pack-trailing');

  // Resolve entries (deltas may point forward or backward; memoise + cycle check).
  const resolved = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: RawEntry): GitObject => {
    if (entry.kind !== 6 && entry.kind !== 7) {
      const type = PACK_TYPES[entry.kind] as ObjType;
      const oid = hashObject(type, entry.data);
      const obj: GitObject = { type, data: entry.data };
      resolved.set(oid, obj);
      return obj;
    }
    if (resolving.has(entry.offset)) throw new Error('pack-delta-cycle');
    resolving.add(entry.offset);
    try {
      let base: GitObject | undefined;
      if (entry.kind === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (!baseEntry) throw new Error('pack-delta-base');
        base = resolveEntry(baseEntry);
      } else {
        const baseOid = entry.baseOid as string;
        // Look in the pack first (by resolved oid), then the caller's store.
        for (const raw of raws) {
          if (raw.kind !== 6 && raw.kind !== 7) {
            const t = PACK_TYPES[raw.kind] as ObjType;
            if (hashObject(t, raw.data) === baseOid) {
              base = { type: t, data: raw.data };
              break;
            }
          }
        }
        if (base === undefined && resolveBase !== undefined) base = resolveBase(baseOid);
        if (base === undefined) throw new Error('pack-delta-base');
      }
      const data = applyDelta(base.data, entry.data);
      const obj: GitObject = { type: base.type, data };
      resolved.set(hashObject(base.type, data), obj);
      return obj;
    } finally {
      resolving.delete(entry.offset);
    }
  };
  for (const entry of raws) resolveEntry(entry);
  return resolved;
}

/** Write a packfile v2 of plain objects (no deltas), deterministic order. */
export function writePack(objects: Iterable<GitObject> | GitObject[]): Buffer {
  const list = Array.isArray(objects) ? objects : [...objects];
  const withOid = list.map((o) => ({ oid: hashObject(o.type, o.data), obj: o }));
  withOid.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(withOid.length, 8);
  parts.push(header);
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const { obj } of withOid) {
    const kind = typeNum[obj.type];
    const size = obj.data.length;
    const head: number[] = [];
    head.push((kind << 4) | (size & 0x0f));
    let remaining = size >> 4;
    while (remaining > 0) {
      head[head.length - 1] |= 0x80;
      head.push(remaining & 0x7f);
      remaining >>= 7;
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------ reachability

/** All objects reachable from `tips` (commits, trees, tags, blobs). */
export function collectReachable(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue; // gitlink: not owned by this repo
        stack.push(e.oid);
      }
    }
  }
  return seen;
}

/** Flatten a tree to full paths -> leaf {oid, mode}. Gitlinks are skipped. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (isTreeMode(e.mode)) {
        walk(e.oid, path);
      } else if (e.mode === '160000') {
        continue;
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
  };
  walk(treeOid, '');
  return out;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (const byte of data) if (byte === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

/** Diff two trees (null = empty tree) into GitHub-style file entries. */
export function diffTrees(objects: Map<string, GitObject>, oldTreeOid: string | null, newTreeOid: string): PullFile[] {
  const oldMap = oldTreeOid === null ? new Map() : flattenTree(objects, oldTreeOid);
  const newMap = flattenTree(objects, newTreeOid);
  const files: PullFile[] = [];
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const path of paths) {
    const o = oldMap.get(path);
    const n = newMap.get(path);
    if (o !== undefined && n !== undefined && o.oid === n.oid) continue;
    if (o === undefined && n !== undefined) {
      const data = objects.get(n.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (o !== undefined && n === undefined) {
      const data = objects.get(o.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (o !== undefined && n !== undefined) {
      const oldData = objects.get(o.oid)?.data ?? Buffer.alloc(0);
      const newData = objects.get(n.oid)?.data ?? Buffer.alloc(0);
      const oldLines = new Set(oldData.toString('utf8').split('\n'));
      const newLines = newData.toString('utf8').split('\n');
      let additions = 0;
      for (const line of newLines) if (!oldLines.has(line)) additions += 1;
      const newSet = new Set(newLines);
      let deletions = 0;
      for (const line of oldData.toString('utf8').split('\n')) if (!newSet.has(line)) deletions += 1;
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

// -------------------------------------------------------------- ancestry

function parentsOf(objects: Map<string, GitObject>, oid: string): string[] {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  try {
    return parseCommit(obj.data).parents;
  } catch {
    return [];
  }
}

/** Nearest common ancestor commit of a and b (BFS from both sides). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const seenA = new Map<string, number>();
  const queueA: [string, number][] = [[a, 0]];
  seenA.set(a, 0);
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift() as [string, number];
    for (const p of parentsOf(objects, oid)) {
      if (!seenA.has(p)) {
        seenA.set(p, depth + 1);
        queueA.push([p, depth + 1]);
      }
    }
  }
  const seenB = new Set<string>();
  const queueB: [string, number][] = [[b, 0]];
  seenB.add(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, depth] = queueB.shift() as [string, number];
    const da = seenA.get(oid);
    if (da !== undefined) {
      const score = da + depth;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    for (const p of parentsOf(objects, oid)) {
      if (!seenB.has(p)) {
        seenB.add(p);
        queueB.push([p, depth + 1]);
      }
    }
  }
  return best;
}

export function isAncestor(objects: Map<string, GitObject>, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const p of parentsOf(objects, oid)) {
      if (p === anc) return true;
      stack.push(p);
    }
  }
  return false;
}

/** Commits from `tip` following parents, tip first, no duplicates. */
export function walkCommits(objects: Map<string, GitObject>, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

/**
 * Mint a commit object with the forge's identity and deterministic time.
 * `objects` is the store the commit will live in (accepted for a uniform
 * call shape across the codebase; the commit is built, not stored, here —
 * the caller stores the returned object).
 */
export function makeCommitObject(
  objects: Map<string, GitObject>,
  treeOid: string,
  parents: string[],
  message: string,
  store: Store,
): { oid: string; obj: GitObject } {
  void objects;
  const epoch = store.now();
  const ident = `${FORGE_IDENT} ${epoch} +0000`;
  const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message, extra: [] });
  const oid = hashObject('commit', data);
  return { oid, obj: { type: 'commit', data } };
}
