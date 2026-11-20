// githttp.ts — Git smart HTTP untuk makefun-github-core-clone-01.
//
// Melayani:
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /<owner>/<repo>.git/git-upload-pack   (v0 + v2: ls-refs, fetch)
//   POST /<owner>/<repo>.git/git-receive-pack  (v0: push + report-status)
//
// Stdlib Node saja, sintaks erasable (type stripping Node 22). Body request
// dibaca dari stream `req` di dalam handleGit (body git bisa besar/biner).
// Tidak ada kredensial di file ini.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  readPack,
  writePack,
  collectReachable,
  flattenTree,
  isAncestor,
  mergeBase,
} from './gitobj.ts';
import type { CommitParts, GitObject, TreeEntry } from './gitobj.ts';
import type { Repo, Store } from './store.ts';

// mergeBase diimpor mengikuti kontrak ARCHITECTURE.md (gitobj.ts); dipakai
// sebagai pemeriksaan konsistensi saat memilih objek kirim bila tersedia.
void mergeBase;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const AGENT = 'makefun-git/1.0';

const FLUSH = Buffer.from('0000', 'ascii');
const CT_UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const CT_RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const CT_UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const CT_RECEIVE_RESULT = 'application/x-git-receive-pack-result';

// ---------------------------------------------------------------------------
// Util HTTP kecil
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  res.end(body);
}

function sendBinary(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
  });
  res.end(body);
}

// Baca seluruh body dari stream request, batas 64 MB.
function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limit) {
        settled = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Pkt-line
// ---------------------------------------------------------------------------

// Satu paket pkt-line: 4 hex panjang (termasuk header) + payload.
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

type Pkt =
  | { kind: 'line'; text: string; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

// Baca satu paket pada posisi `pos`. Mengembalikan `{ raw: true }` bila 4 byte
// berikutnya bukan panjang pkt-line (dipakai pendeteksi pack mentah).
function readPkt(
  buf: Buffer,
  pos: number,
): { pkt: Pkt; next: number } | { raw: true; pos: number } {
  if (pos + 4 > buf.length) throw new Error('pkt-line truncated');
  const head = buf.subarray(pos, pos + 4).toString('ascii');
  if (head === '0000') return { pkt: { kind: 'flush' }, next: pos + 4 };
  if (head === '0001') return { pkt: { kind: 'delim' }, next: pos + 4 };
  if (head === '0002') return { pkt: { kind: 'end' }, next: pos + 4 };
  if (!/^[0-9a-fA-F]{4}$/.test(head)) return { raw: true, pos };
  const len = parseInt(head, 16);
  if (len < 4 || len > 65520) throw new Error('pkt-line bad length');
  if (pos + len > buf.length) throw new Error('pkt-line truncated');
  const raw = Buffer.from(buf.subarray(pos + 4, pos + len));
  return { pkt: { kind: 'line', text: raw.toString('utf8'), raw }, next: pos + len };
}

// Kumpulkan semua baris pkt-line sampai flush (delim/end dilewati).
// Throw bila ada byte mentah atau paket terpotong.
function parseAllLines(body: Buffer): string[] {
  const lines: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    const r = readPkt(body, pos);
    if ('raw' in r) throw new Error('malformed pkt-line');
    pos = r.next;
    if (r.pkt.kind === 'flush') break;
    if (r.pkt.kind === 'line') lines.push(r.pkt.text);
  }
  return lines;
}

function isOid(s: string): boolean {
  return OID_RE.test(s);
}

// ---------------------------------------------------------------------------
// Bantuan model objek (di atas gitobj.ts / Store)
// ---------------------------------------------------------------------------

function commitParents(objects: Map<string, GitObject>, oid: string): string[] | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return parseCommit(obj.data).parents;
  } catch {
    return null;
  }
}

function commitTree(objects: Map<string, GitObject>, oid: string): string | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return parseCommit(obj.data).tree;
  } catch {
    return null;
  }
}

// Oid hasil peel untuk ref tag anotasi, atau null bila bukan tag anotasi.
function peeledOid(repo: Repo, ref: string, oid: string): string | null {
  void ref;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  try {
    return parseTag(obj.data).object;
  } catch {
    return null;
  }
}

// Tambahkan treeOid beserta seluruh subtree dan blob di bawahnya ke `out`.
// Gitlink (mode 160000) dilewati.
function treeClosure(objects: Map<string, GitObject>, treeOid: string, out: Set<string>): void {
  const root = objects.get(treeOid);
  if (!root || root.type !== 'tree') return;
  // Objek tree perantara via walk parseTree.
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (out.has(current)) continue;
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tree') continue;
    out.add(current);
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.mode === '160000') continue;
      const child = objects.get(entry.oid);
      if (!child) continue;
      if (child.type === 'tree') stack.push(entry.oid);
    }
  }
  // Daun (blob) via flattenTree.
  const leaves = flattenTree(objects, treeOid);
  for (const leaf of leaves.values()) {
    if (objects.has(leaf.oid)) out.add(leaf.oid);
  }
}

// Semua objek yang reachable dari `tips` (commit -> tree + parents,
// tag -> target, tree -> entri kecuali gitlink). Traversal parent berhenti
// pada commit di `stopAt` (commit itu sendiri beserta tree-nya tetap masuk,
// parent-nya tidak) — dipakai untuk haves dengan shallow boundary.
function reachableObjects(
  objects: Map<string, GitObject>,
  tips: string[],
  stopAt: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  let i = 0;
  while (i < queue.length) {
    const oid = queue[i] as string;
    i += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      out.add(oid);
      try {
        queue.push(parseTag(obj.data).object);
      } catch {
        // Tag rusak: abaikan targetnya.
      }
      continue;
    }
    if (obj.type === 'commit') {
      out.add(oid);
      let parts: CommitParts;
      try {
        parts = parseCommit(obj.data);
      } catch {
        continue;
      }
      treeClosure(objects, parts.tree, out);
      if (!stopAt.has(oid)) {
        for (const parent of parts.parents) queue.push(parent);
      }
      continue;
    }
    // Tree / blob sebagai tip langsung.
    out.add(oid);
    if (obj.type === 'tree') treeClosure(objects, oid, out);
  }
  return out;
}

// BFS commit dari `starts`, mengembalikan peta commit -> level (0 = tip).
// Bila maxDepth !== null, commit pada level >= maxDepth tidak di-expand.
function depthLimitedCommits(
  objects: Map<string, GitObject>,
  starts: string[],
  maxDepth: number | null,
): Map<string, number> {
  const levels = new Map<string, number>();
  const queue: string[] = [];
  for (const start of starts) {
    if (!levels.has(start)) {
      levels.set(start, 0);
      queue.push(start);
    }
  }
  let i = 0;
  while (i < queue.length) {
    const oid = queue[i] as string;
    i += 1;
    const level = levels.get(oid) as number;
    if (maxDepth !== null && level + 1 >= maxDepth) continue;
    const parents = commitParents(objects, oid);
    if (!parents) continue;
    for (const parent of parents) {
      if (!levels.has(parent)) {
        levels.set(parent, level + 1);
        queue.push(parent);
      }
    }
  }
  return levels;
}

// Ikuti rantai tag dari `oid`: kembalikan commit target (bila ada) beserta
// oid-oid perantara (tag itu sendiri, atau tree/blob bila want bukan commit).
function resolveWant(
  objects: Map<string, GitObject>,
  oid: string,
): { commit: string | null; extra: string[] } {
  const extra: string[] = [];
  const seen = new Set<string>();
  let cur = oid;
  for (;;) {
    const obj = objects.get(cur);
    if (!obj) return { commit: null, extra };
    if (obj.type === 'tag') {
      if (seen.has(cur)) return { commit: null, extra };
      seen.add(cur);
      extra.push(cur);
      try {
        cur = parseTag(obj.data).object;
      } catch {
        return { commit: null, extra };
      }
      continue;
    }
    if (obj.type === 'commit') return { commit: cur, extra };
    extra.push(cur);
    return { commit: null, extra };
  }
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktLine(`# service=${service}\n`));
  chunks.push(FLUSH);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${repo.headRef} side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = [...repo.refs.entries()];
  if (refs.length === 0) {
    // Repo kosong: pseudo-ref capabilities^{} membawa capabilities.
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(repo.headRef) ?? ZERO_OID;
    chunks.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      chunks.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peeledOid(repo, ref, oid);
      if (peeled) chunks.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (protokol v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const include = (ref: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));

  const out: Buffer[] = [];
  const headOid = repo.refs.get(repo.headRef);
  if (include('HEAD')) {
    if (headOid) {
      const extra = symrefs ? ` symref-target:${repo.headRef}` : '';
      out.push(pktLine(`${headOid} HEAD${extra}\n`));
    } else if (unborn) {
      const extra = symrefs ? ` symref-target:${repo.headRef}` : '';
      out.push(pktLine(`unborn HEAD${extra}\n`));
    }
  }
  for (const [ref, oid] of repo.refs) {
    if (!include(ref)) continue;
    let extra = '';
    if (peel) {
      const peeled = peeledOid(repo, ref, oid);
      if (peeled) extra += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${oid} ${ref}${extra}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Fetch (v2 dan v0 berbagi inti perhitungan yang sama)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], deepen: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim().split(/\s+/)[0] as string;
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.shallows.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.deepen = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done, agent,
    // object-format, command: diabaikan (tidak mengubah isi kiriman).
  }
  return args;
}

function computeShallow(
  objects: Map<string, GitObject>,
  levels: Map<string, number> | null,
  sendCommits: Set<string>,
  existing: string[],
  deepen: number | null,
  available: Set<string>,
): { shallow: string[]; unshallow: string[] } {
  const shallow = new Set<string>();
  const unshallow: string[] = [];
  if (deepen !== null && levels) {
    for (const commit of sendCommits) {
      if (levels.get(commit) === deepen - 1) {
        const parents = commitParents(objects, commit);
        if (parents && parents.length > 0) shallow.add(commit);
      }
    }
  }
  for (const boundary of existing) {
    const parents = commitParents(objects, boundary);
    if (!parents || parents.length === 0) continue;
    if (parents.every((p) => available.has(p))) unshallow.push(boundary);
    else shallow.add(boundary);
  }
  for (const u of unshallow) shallow.delete(u);
  return { shallow: [...shallow], unshallow };
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

// Inti fetch: objek yang dikirim = reachable dari wants MINUS reachable
// dari haves (traversal haves berhenti pada shallow boundary). Bila deepen
// diminta, commit dibatasi kedalaman dari wants.
function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallows: string[],
  deepen: number | null,
): FetchPlan {
  const objects = repo.objects;
  const extraOids: string[] = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    const resolved = resolveWant(objects, want);
    if (resolved.commit) wantCommits.push(resolved.commit);
    for (const extra of resolved.extra) extraOids.push(extra);
  }

  const stopAt = new Set<string>(shallows);
  const haveObjects = reachableObjects(objects, haves, stopAt);

  let wantObjects: Set<string>;
  let levels: Map<string, number> | null = null;
  if (deepen === null) {
    wantObjects = collectReachable(objects, wants);
  } else {
    levels = depthLimitedCommits(objects, wantCommits, deepen);
    wantObjects = new Set<string>();
    for (const commit of levels.keys()) {
      wantObjects.add(commit);
      const tree = commitTree(objects, commit);
      if (tree) treeClosure(objects, tree, wantObjects);
    }
    for (const extra of extraOids) wantObjects.add(extra);
  }

  const sendOids = new Set<string>();
  for (const oid of wantObjects) {
    if (!haveObjects.has(oid)) sendOids.add(oid);
  }

  // Commit yang benar-benar dikirim (untuk perhitungan shallow-info).
  let sendCommits: Set<string>;
  if (levels) {
    sendCommits = new Set<string>();
    for (const commit of levels.keys()) {
      if (!haveObjects.has(commit)) sendCommits.add(commit);
    }
  } else {
    sendCommits = new Set<string>();
    for (const oid of sendOids) {
      const obj = objects.get(oid);
      if (obj && obj.type === 'commit') sendCommits.add(oid);
    }
  }

  const available = new Set<string>([...sendOids, ...haveObjects]);
  const { shallow, unshallow } = computeShallow(
    objects,
    levels,
    sendCommits,
    shallows,
    deepen,
    available,
  );

  const packObjects: GitObject[] = [];
  for (const oid of sendOids) {
    const obj = objects.get(oid);
    if (obj) packObjects.push(obj);
  }
  return { pack: writePack(packObjects), shallow, unshallow };
}

// Pack sebagai sideband band 1: tiap paket pkt-line <= 65520 byte,
// payload = 1 byte band + <= 65515 byte data pack.
function sidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65520 - 5;
  for (let off = 0; off < pack.length; off += maxData) {
    const slice = pack.subarray(off, Math.min(pack.length, off + maxData));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const args = parseFetchArgs(lines);
  const plan = computeFetch(repo, args.wants, args.haves, args.shallows, args.deepen);
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  chunks.push(pktLine('NAK\n'));
  chunks.push(FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(FLUSH);
  }
  chunks.push(pktLine('packfile\n'));
  for (const chunk of sidebandChunks(plan.pack)) chunks.push(chunk);
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// v0 upload-pack: dua seksi pkt-line (want+capabilities lalu have+done).
// Jawab: NAK, baris shallow/unshallow, lalu pack via sideband (bila
// side-band-64k dinegosiasikan) atau pack mentah.
function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  let pos = 0;
  const lines1: string[] = [];
  const lines2: string[] = [];
  for (;;) {
    const r = readPkt(body, pos);
    if ('raw' in r) throw new Error('malformed pkt-line in upload-pack request');
    pos = r.next;
    if (r.pkt.kind === 'flush') break;
    if (r.pkt.kind === 'line') lines1.push(r.pkt.text);
  }
  while (pos < body.length) {
    const r = readPkt(body, pos);
    if ('raw' in r) throw new Error('malformed pkt-line in upload-pack request');
    pos = r.next;
    if (r.pkt.kind === 'flush') break;
    if (r.pkt.kind === 'line') lines2.push(r.pkt.text);
  }

  const args = parseFetchArgs(lines1);
  const args2 = parseFetchArgs(lines2);
  args.haves.push(...args2.haves);
  if (args.deepen === null) args.deepen = args2.deepen;
  if (args.shallows.length === 0) args.shallows.push(...args2.shallows);

  let sideband = false;
  for (const raw of lines1) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const caps = line.slice(5).trim().split(/\s+/).slice(1);
      sideband = caps.includes('side-band-64k');
      break;
    }
  }

  const plan = computeFetch(repo, args.wants, args.haves, args.shallows, args.deepen);
  const chunks: Buffer[] = [];
  chunks.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  if (sideband) {
    for (const chunk of sidebandChunks(plan.pack)) chunks.push(chunk);
    chunks.push(FLUSH);
  } else {
    // Tanpa sideband: pack mentah sampai akhir stream (tanpa flush).
    chunks.push(plan.pack);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// receive-pack (v0): push + report-status
// ---------------------------------------------------------------------------

interface PushCommand {
  old: string;
  nw: string;
  ref: string;
}

function applyCommand(repo: Repo, cmd: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
  if (cmd.nw === ZERO_OID) {
    // Delete.
    if (current === ZERO_OID) return { ok: false, reason: 'remote ref does not exist' };
    if (cmd.old !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(cmd.ref);
    return { ok: true, reason: '' };
  }
  if (cmd.old === ZERO_OID) {
    // Create.
    if (current !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    if (!repo.objects.has(cmd.nw)) return { ok: false, reason: 'object not found' };
    repo.refs.set(cmd.ref, cmd.nw);
    return { ok: true, reason: '' };
  }
  // Update: old harus sama dengan tip saat ini dan new harus turunan old.
  if (cmd.old !== current) return { ok: false, reason: 'non-fast-forward' };
  if (!repo.objects.has(cmd.nw)) return { ok: false, reason: 'object not found' };
  if (!isAncestor(repo.objects, cmd.old, cmd.nw)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(cmd.ref, cmd.nw);
  return { ok: true, reason: '' };
}

// Mengembalikan body respons report-status. Throw bila body malformed.
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  let pos = 0;
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  for (;;) {
    const r = readPkt(body, pos);
    if ('raw' in r) throw new Error('malformed pkt-line in receive-pack request');
    pos = r.next;
    if (r.pkt.kind === 'flush') break;
    if (r.pkt.kind !== 'line') continue;
    let text = r.pkt.text;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text
        .slice(nul + 1)
        .replace(/\n$/, '')
        .split(/\s+/)
        .filter((s) => s.length > 0);
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
    if (!m) throw new Error('malformed receive-pack command');
    commands.push({ old: m[1] as string, nw: m[2] as string, ref: m[3] as string });
  }
  if (commands.length === 0) throw new Error('empty receive-pack request');

  // Pack mengikuti daftar perintah (bisa kosong untuk push delete-only).
  const packBytes = body.subarray(pos);
  const sideband = caps.includes('side-band-64k');
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes, (oid: string) => repo.objects.get(oid));
      for (const [oid, obj] of objs) {
        // Objek hasil resolve harus merekomputasi ke oid-nya.
        if (hashObject(obj.type, obj.data) !== oid) {
          throw new Error('pack object hash mismatch');
        }
        repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err instanceof Error ? err.message : String(err))
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 200);
    }
  }

  const report: string[] = [];
  if (unpackOk) {
    report.push('unpack ok');
    for (const cmd of commands) {
      const result = applyCommand(repo, cmd);
      report.push(result.ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${result.reason}`);
    }
  } else {
    report.push(`unpack ${unpackDetail}`);
    for (const cmd of commands) report.push(`ng ${cmd.ref} ${unpackDetail}`);
  }

  if (sideband) {
    // Laporan lewat band 1 (pkt-line di dalam band 1), lalu flush.
    const chunks = report.map((line) =>
      pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line + '\n', 'utf8')])),
    );
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  const chunks = report.map((line) => pktLine(line + '\n'));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Dispatcher utama
// ---------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter((p) => p.length > 0);
  if (parts.length < 2 || !parts[1]?.endsWith('.git')) return false;
  const owner = parts[0] as string;
  const repoName = (parts[1] as string).slice(0, -4);
  const rest = parts.slice(2);
  const isInfoRefs = rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs';
  const isUpload = rest.length === 1 && rest[0] === 'git-upload-pack';
  const isReceive = rest.length === 1 && rest[0] === 'git-receive-pack';
  if (!isInfoRefs && !isUpload && !isReceive) return false;

  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName)) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Auth Bearer pada semua endpoint git.
  const auth = req.headers.authorization ?? '';
  if (!token || auth !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }

  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (isInfoRefs) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // receive-pack hanya v0; upload-pack v2 bila diminta via Git-Protocol.
    const v2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    const body = v2 ? advertiseV2() : advertiseV0(repo, service);
    const contentType =
      service === 'git-upload-pack' ? CT_UPLOAD_ADVERTISEMENT : CT_RECEIVE_ADVERTISEMENT;
    sendBinary(res, 200, contentType, body);
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'malformed request body' });
    return true;
  }

  if (isUpload) {
    // Deteksi v2: header Git-Protocol, atau baris pertama `command=...`.
    let firstLine = '';
    try {
      const r = readPkt(body, 0);
      if (!('raw' in r) && r.pkt.kind === 'line') firstLine = r.pkt.text;
    } catch {
      // Body malformed: ditangani sebagai v0 di bawah (akan 400).
    }
    const isV2 = req.headers['git-protocol'] === 'version=2' || firstLine.startsWith('command=');
    if (isV2) {
      let lines: string[];
      try {
        lines = parseAllLines(body);
      } catch {
        sendJson(res, 400, { message: 'malformed pkt-line' });
        return true;
      }
      const cmdLine = lines.find((l) => l.startsWith('command='));
      const command = cmdLine ? cmdLine.slice('command='.length).trim() : '';
      if (command === 'ls-refs') {
        sendBinary(res, 200, CT_UPLOAD_RESULT, handleLsRefs(repo, lines));
      } else if (command === 'fetch') {
        sendBinary(res, 200, CT_UPLOAD_RESULT, handleFetchV2(repo, lines));
      } else {
        sendJson(res, 400, { message: 'unknown git command' });
      }
      return true;
    }
    try {
      sendBinary(res, 200, CT_UPLOAD_RESULT, handleFetchV0(repo, body));
    } catch {
      sendJson(res, 400, { message: 'malformed pkt-line' });
    }
    return true;
  }

  // git-receive-pack.
  try {
    sendBinary(res, 200, CT_RECEIVE_RESULT, handleReceivePack(repo, body));
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
  }
  return true;
}
