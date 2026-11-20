// REST v3 (GitHub API) — makefun-github-core-clone-01
//
// Menangani semua endpoint di bawah prefix /api/v3. Memakai Store yang sama
// dengan permukaan git / GraphQL / MCP. Semua respons JSON dan selalu membawa
// header X-GitHub-Request-Id (lihat helper sendJson di bawah).
//
// Aturan determinisme: tidak ada Date.now() / Math.random() pada data yang
// disajikan. Timestamp commit memakai store.now() (lewat makeCommitObject);
// merged_at memakai string konstan.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import type { Store, Repo, Issue, PullRequest } from './store.ts';
import type { TreeEntry } from './gitobj.ts';
import {
  hashObject,
  buildTree,
  isTreeMode,
  parseTree,
  parseCommit,
  flattenTree,
  diffTrees,
  mergeBase,
  walkCommits,
  makeCommitObject,
} from './gitobj.ts';

const MERGED_AT = '2026-11-20T00:00:00Z';
const VIEWER_ID = 1000;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return 'req-' + requestCounter;
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
  };
  if (extra) {
    for (const key of Object.keys(extra)) {
      headers[key] = extra[key];
    }
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(value));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

type JsonObject = Record<string, unknown>;

function parseJsonBody(
  body: Buffer,
): { ok: true; value: JsonObject } | { ok: false } {
  if (body.length === 0) {
    return { ok: true, value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as JsonObject };
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return undefined;
    }
    out.push(item);
  }
  return out;
}

function parsePageParam(raw: string | null, fallback: number): number {
  if (raw === null) {
    return fallback;
  }
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    return fallback;
  }
  return n;
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function pageLinkHeader(
  origin: string,
  path: string,
  params: URLSearchParams,
  page: number,
  perPage: number,
  total: number,
): string | undefined {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) {
    return undefined;
  }
  const make = (p: number, rel: string): string => {
    const q = new URLSearchParams(params);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return '<' + origin + path + '?' + q.toString() + '>; rel="' + rel + '"';
  };
  const parts: string[] = [];
  if (page < totalPages) {
    parts.push(make(page + 1, 'next'));
    parts.push(make(totalPages, 'last'));
  }
  if (page > 1) {
    parts.push(make(1, 'first'));
    parts.push(make(page - 1, 'prev'));
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Bentuk JSON respons
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): JsonObject {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name,
  };
}

function issueJson(repo: Repo, issue: Issue): JsonObject {
  return {
    // Stable numeric id (GitHub's database id): unique per repo + number.
    id: repo.databaseId * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullJson(pr: PullRequest): JsonObject {
  return {
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
  };
}

// ---------------------------------------------------------------------------
// Resolusi ref / commit / tree
// ---------------------------------------------------------------------------

// Mengembalikan oid tip commit untuk sebuah ref: nama branch, 'refs/heads/x',
// atau SHA-40 commit. undefined bila ref tidak ada / belum lahir.
function resolveRefTip(repo: Repo, ref: string | undefined | null): string | undefined {
  if (ref === undefined || ref === null || ref === '') {
    return repo.refs.get(repo.headRef) ?? repo.refs.get('refs/heads/' + repo.defaultBranch);
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const lower = ref.toLowerCase();
    if (repo.objects.has(lower)) {
      return lower;
    }
    return undefined;
  }
  const byHead = repo.refs.get('refs/heads/' + ref);
  if (byHead !== undefined) {
    return byHead;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) {
    return direct;
  }
  return undefined;
}

function commitTreeOid(repo: Repo, commitOid: string): string | undefined {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') {
    return undefined;
  }
  try {
    return parseCommit(obj.data).tree;
  } catch {
    return undefined;
  }
}

function treeEntriesOf(repo: Repo, treeOid: string | null): TreeEntry[] {
  if (treeOid === null) {
    return [];
  }
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') {
    return [];
  }
  try {
    return parseTree(obj.data);
  } catch {
    return [];
  }
}

function storeTree(repo: Repo, entries: TreeEntry[]): string {
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

// Mengganti/menambah blob pada path (segmen-segmen) di dalam tree; mengembalikan
// oid tree baru. Tree lama tidak diubah (struktur persisten).
function setPathInTree(
  repo: Repo,
  treeOid: string | null,
  segments: string[],
  blobOid: string,
): string {
  const entries = treeEntriesOf(repo, treeOid);
  const head = segments[0];
  const rest = segments.slice(1);
  let next: TreeEntry[];
  if (rest.length === 0) {
    next = entries.filter((e) => e.name !== head);
    next.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((e) => e.name === head);
    const subOid =
      existing !== undefined && isTreeMode(existing.mode) ? existing.oid : null;
    const newSub = setPathInTree(repo, subOid, rest, blobOid);
    next = entries.filter((e) => e.name !== head);
    next.push({ mode: '40000', name: head, oid: newSub });
  }
  return storeTree(repo, next);
}

// Menghapus path dari tree; mengembalikan oid tree baru. Entri direktori yang
// menjadi kosong ikut dihapus.
function removePathFromTree(
  repo: Repo,
  treeOid: string | null,
  segments: string[],
): string {
  const entries = treeEntriesOf(repo, treeOid);
  const head = segments[0];
  const rest = segments.slice(1);
  let next: TreeEntry[];
  if (rest.length === 0) {
    next = entries.filter((e) => e.name !== head);
  } else {
    const existing = entries.find((e) => e.name === head);
    if (existing === undefined || !isTreeMode(existing.mode)) {
      return treeOid ?? storeTree(repo, []);
    }
    const newSub = removePathFromTree(repo, existing.oid, rest);
    const subEntries = treeEntriesOf(repo, newSub);
    next = entries.filter((e) => e.name !== head);
    if (subEntries.length > 0) {
      next.push({ mode: '40000', name: head, oid: newSub });
    }
  }
  return storeTree(repo, next);
}

// Menavigasi tree mengikuti segmen-segmen path. Mengembalikan null bila path
// tidak ada. kind 'tree' untuk direktori, 'blob' untuk file.
function navigateTree(
  repo: Repo,
  treeOid: string,
  segments: string[],
): { kind: 'tree' | 'blob'; oid: string } | null {
  let currentOid = treeOid;
  for (let i = 0; i < segments.length; i++) {
    const entries = treeEntriesOf(repo, currentOid);
    const found = entries.find((e) => e.name === segments[i]);
    if (found === undefined) {
      return null;
    }
    if (i === segments.length - 1) {
      return { kind: isTreeMode(found.mode) ? 'tree' : 'blob', oid: found.oid };
    }
    if (!isTreeMode(found.mode)) {
      return null;
    }
    currentOid = found.oid;
  }
  return { kind: 'tree', oid: currentOid };
}

// Deteksi konflik merge: file yang diubah di KEDUA sisi terhadap merge-base
// dengan isi akhir yang berbeda.
function hasMergeConflict(
  repo: Repo,
  mergeBaseTree: string | null,
  headTree: string,
  baseTree: string,
): boolean {
  const mb = mergeBaseTree === null ? new Map() : flattenTree(repo.objects, mergeBaseTree);
  const hd = flattenTree(repo.objects, headTree);
  const bs = flattenTree(repo.objects, baseTree);
  const paths = new Set<string>([...hd.keys(), ...bs.keys()]);
  for (const path of paths) {
    const m = mb.get(path)?.oid ?? null;
    const h = hd.get(path)?.oid ?? null;
    const b = bs.get(path)?.oid ?? null;
    if (h !== m && b !== m && h !== b) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Handler utama
// ---------------------------------------------------------------------------

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
  body: Buffer,
): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    sendError(res, 400, 'Bad request URL');
    return true;
  }
  const pathname = url.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) {
    return false;
  }

  // Auth: semua endpoint /api/v3 butuh Bearer persis.
  const auth = req.headers.authorization ?? '';
  if (!token || auth !== 'Bearer ' + token) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const segments = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => safeDecode(s));
  const query = url.searchParams;
  const origin = 'http://' + (req.headers.host ?? 'localhost');

  const needJsonBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let jsonBody: JsonObject = {};
  if (needJsonBody) {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'Invalid JSON body');
      return true;
    }
    jsonBody = parsed.value;
  }

  const page = parsePageParam(query.get('page'), 1);
  const perPage = Math.min(100, parsePageParam(query.get('per_page'), 30));

  // -- Root & meta -----------------------------------------------------------
  if (segments.length === 2) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (segments.length === 3 && segments[2] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (segments.length === 3 && segments[2] === 'user') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { login: store.viewerLogin, id: VIEWER_ID, type: 'User' });
    return true;
  }

  // -- POST /user/repos & GET /user/repos ------------------------------------
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      const name = asString(jsonBody['name']);
      if (name === undefined || name === '' || name.length > 100) {
        sendError(res, 422, 'Invalid repository name');
        return true;
      }
      const isPrivate = jsonBody['private'] === true;
      const description = asString(jsonBody['description']) ?? '';
      const created = store.createRepo(store.viewerLogin, name, isPrivate, description);
      if (created === null) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, 201, repoJson(created));
      return true;
    }
    if (method === 'GET') {
      const all = store.listRepos(store.viewerLogin);
      const items = paginate(all, page, perPage).map((r) => repoJson(r));
      const link = pageLinkHeader(origin, '/api/v3/user/repos', query, page, perPage, all.length);
      sendJson(res, 200, items, link !== undefined ? { link } : undefined);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // -- Semua rute /repos/{owner}/{repo}/... ----------------------------------
  if (segments.length >= 5 && segments[2] === 'repos') {
    const owner = segments[3];
    const repoName = segments[4];

    // Repo milik owner lain -> 404, tidak pernah 403.
    if (owner !== store.viewerLogin) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }

    const rest = segments.slice(5);

    // GET / PATCH / DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const description = asString(jsonBody['description']);
        if (description !== undefined) {
          repo.description = description;
        }
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendNoContent(res);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const ref = asString(jsonBody['ref']);
      const sha = asString(jsonBody['sha']);
      if (ref === undefined || sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() } });
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const branches: JsonObject[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
        }
      }
      sendJson(res, 200, branches);
      return true;
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const tip = resolveRefTip(repo, query.get('sha'));
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const oids = walkCommits(repo.objects, tip);
      const out: JsonObject[] = [];
      for (const oid of oids) {
        const obj = repo.objects.get(oid);
        if (obj === undefined || obj.type !== 'commit') {
          continue;
        }
        let message = '';
        try {
          message = parseCommit(obj.data).message;
        } catch {
          message = '';
        }
        out.push({ sha: oid, commit: { message } });
      }
      sendJson(res, 200, out);
      return true;
    }

    // PUT / GET / DELETE /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const pathSegments = rest.slice(1);
      const filePath = pathSegments.join('/');

      if (method === 'PUT') {
        const message = asString(jsonBody['message']) ?? '';
        const contentB64 = asString(jsonBody['content']);
        if (contentB64 === undefined) {
          sendError(res, 400, 'content is required');
          return true;
        }
        if (filePath === '') {
          sendError(res, 422, 'Invalid path');
          return true;
        }
        const branch = asString(jsonBody['branch']) ?? repo.defaultBranch;
        const refKey = 'refs/heads/' + branch;
        const tip = repo.refs.get(refKey);
        const oldTreeOid = tip === undefined ? null : commitTreeOid(repo, tip) ?? null;
        const flat =
          oldTreeOid === null ? new Map() : flattenTree(repo.objects, oldTreeOid);
        const existing = flat.get(filePath);
        const givenSha = asString(jsonBody['sha']);
        if (
          existing !== undefined &&
          givenSha !== undefined &&
          givenSha.toLowerCase() !== existing.oid.toLowerCase()
        ) {
          sendError(res, 409, 'sha does not match the current file');
          return true;
        }
        const isCreate = existing === undefined;
        const contentBuf = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        const blobOid = hashObject('blob', contentBuf);
        repo.objects.set(blobOid, { type: 'blob', data: contentBuf });
        const newTreeOid = setPathInTree(repo, oldTreeOid, pathSegments, blobOid);
        const parents = tip === undefined ? [] : [tip];
        const made = makeCommitObject(repo.objects, newTreeOid, parents, message, store);
        repo.objects.set(made.oid, made.obj);
        repo.refs.set(refKey, made.oid);
        sendJson(res, isCreate ? 201 : 200, {
          content: {
            name: pathSegments[pathSegments.length - 1],
            path: filePath,
            sha: blobOid,
            size: contentBuf.length,
            type: 'file',
            encoding: 'base64',
          },
          commit: { sha: made.oid, message },
        });
        return true;
      }

      if (method === 'GET') {
        const tip = resolveRefTip(repo, query.get('ref'));
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const treeOid = commitTreeOid(repo, tip);
        if (treeOid === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (filePath === '') {
          const entries = treeEntriesOf(repo, treeOid);
          sendJson(
            res,
            200,
            entries.map((e) => ({
              type: isTreeMode(e.mode) ? 'dir' : 'file',
              name: e.name,
              path: e.name,
              sha: e.oid,
            })),
          );
          return true;
        }
        const found = navigateTree(repo, treeOid, pathSegments);
        if (found === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (found.kind === 'tree') {
          const entries = treeEntriesOf(repo, found.oid);
          sendJson(
            res,
            200,
            entries.map((e) => ({
              type: isTreeMode(e.mode) ? 'dir' : 'file',
              name: e.name,
              path: filePath + '/' + e.name,
              sha: e.oid,
            })),
          );
          return true;
        }
        const blob = repo.objects.get(found.oid);
        if (blob === undefined || blob.type !== 'blob') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: found.oid,
          size: blob.data.length,
          name: pathSegments[pathSegments.length - 1],
          path: filePath,
        });
        return true;
      }

      if (method === 'DELETE') {
        const message = asString(jsonBody['message']) ?? '';
        if (filePath === '') {
          sendError(res, 422, 'Invalid path');
          return true;
        }
        const branch = asString(jsonBody['branch']) ?? repo.defaultBranch;
        const refKey = 'refs/heads/' + branch;
        const tip = repo.refs.get(refKey);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const oldTreeOid = commitTreeOid(repo, tip);
        if (oldTreeOid === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const flat = flattenTree(repo.objects, oldTreeOid);
        const existing = flat.get(filePath);
        if (existing === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const givenSha = asString(jsonBody['sha']);
        if (
          givenSha !== undefined &&
          givenSha.toLowerCase() !== existing.oid.toLowerCase()
        ) {
          sendError(res, 409, 'sha does not match the current file');
          return true;
        }
        const newTreeOid = removePathFromTree(repo, oldTreeOid, pathSegments);
        const made = makeCommitObject(repo.objects, newTreeOid, [tip], message, store);
        repo.objects.set(made.oid, made.obj);
        repo.refs.set(refKey, made.oid);
        sendJson(res, 200, { commit: { sha: made.oid, message } });
        return true;
      }

      sendError(res, 404, 'Not Found');
      return true;
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const name = asString(jsonBody['name']);
      if (name === undefined || name === '') {
        sendError(res, 422, 'Invalid label name');
        return true;
      }
      const color = asString(jsonBody['color']) ?? 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return true;
    }

    // POST / GET /repos/{o}/{r}/issues
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'POST') {
        const title = asString(jsonBody['title']);
        if (title === undefined) {
          sendError(res, 422, 'title is required');
          return true;
        }
        const bodyText = asString(jsonBody['body']) ?? '';
        const labelNames = asStringArray(jsonBody['labels']) ?? [];
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) {
            sendError(res, 422, 'Label does not exist: ' + labelName);
            return true;
          }
        }
        const issue: Issue = {
          number: repo.nextIssue,
          title,
          body: bodyText,
          state: 'open',
          labels: [...labelNames],
          comments: [],
          seq: store.seq,
        };
        repo.nextIssue += 1;
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      if (method === 'GET') {
        const stateFilter = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (stateFilter === 'open' || stateFilter === 'closed') {
          list = list.filter((i) => i.state === stateFilter);
        }
        if (sort === 'created') {
          list.sort((a, b) => {
            if (a.seq !== b.seq) {
              return direction === 'asc' ? a.seq - b.seq : b.seq - a.seq;
            }
            return direction === 'asc' ? a.number - b.number : b.number - a.number;
          });
        }
        const items = paginate(list, page, perPage).map((i) => issueJson(repo, i));
        const link = pageLinkHeader(
          origin,
          '/api/v3/repos/' + owner + '/' + repoName + '/issues',
          query,
          page,
          perPage,
          list.length,
        );
        sendJson(res, 200, items, link !== undefined ? { link } : undefined);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // GET / PATCH /repos/{o}/{r}/issues/{n}  dan  komentar
    if (rest.length >= 2 && rest[0] === 'issues') {
      const issueNumber = parseInt(rest[1], 10);
      if (Number.isNaN(issueNumber)) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.get(issueNumber);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const state = asString(jsonBody['state']);
          if (state === 'open' || state === 'closed') {
            issue.state = state;
          }
          const title = asString(jsonBody['title']);
          if (title !== undefined) {
            issue.title = title;
          }
          const bodyText = asString(jsonBody['body']);
          if (bodyText !== undefined) {
            issue.body = bodyText;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const commentBody = asString(jsonBody['body']);
          if (commentBody === undefined) {
            sendError(res, 422, 'body is required');
            return true;
          }
          const comment = { id: repo.nextCommentId, body: commentBody };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body });
          return true;
        }
        if (method === 'GET') {
          sendJson(
            res,
            200,
            issue.comments.map((c) => ({ id: c.id, body: c.body })),
          );
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // POST / GET /repos/{o}/{r}/pulls
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'POST') {
        const headRef = asString(jsonBody['head']);
        const baseRef = asString(jsonBody['base']);
        const title = asString(jsonBody['title']);
        if (headRef === undefined || baseRef === undefined || title === undefined) {
          sendError(res, 422, 'head, base, and title are required');
          return true;
        }
        const bodyText = asString(jsonBody['body']) ?? '';
        const headSha = resolveRefTip(repo, headRef);
        const baseSha = resolveRefTip(repo, baseRef);
        if (headSha === undefined || baseSha === undefined) {
          sendError(res, 422, 'head or base branch not found');
          return true;
        }
        const headTree = commitTreeOid(repo, headSha);
        const baseTree = commitTreeOid(repo, baseSha);
        if (headTree === undefined || baseTree === undefined) {
          sendError(res, 422, 'head or base has no commits');
          return true;
        }
        const files = diffTrees(repo.objects, baseTree, headTree);
        const pr: PullRequest = {
          number: repo.nextPull,
          title,
          body: bodyText,
          state: 'open',
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          head: { ref: headRef, sha: headSha },
          base: { ref: baseRef, sha: baseSha },
          files,
          seq: store.seq,
        };
        repo.nextPull += 1;
        repo.pulls.set(pr.number, pr);
        sendJson(res, 201, pullJson(pr));
        return true;
      }
      if (method === 'GET') {
        const stateFilter = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (stateFilter === 'open' || stateFilter === 'closed') {
          list = list.filter((p) => p.state === stateFilter);
        }
        list.sort((a, b) => a.number - b.number);
        const items = paginate(list, page, perPage).map((p) => pullJson(p));
        const link = pageLinkHeader(
          origin,
          '/api/v3/repos/' + owner + '/' + repoName + '/pulls',
          query,
          page,
          perPage,
          list.length,
        );
        sendJson(res, 200, items, link !== undefined ? { link } : undefined);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // GET /repos/{o}/{r}/pulls/{n}  dan  /files  dan  /merge
    if (rest.length >= 2 && rest[0] === 'pulls') {
      const prNumber = parseInt(rest[1], 10);
      if (Number.isNaN(prNumber)) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pr = repo.pulls.get(prNumber);
      if (pr === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method !== 'GET') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(pr));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(
          res,
          200,
          pr.files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        );
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pr.merged || pr.state === 'closed') {
          sendError(res, 405, 'Pull request already merged or closed');
          return true;
        }
        const baseTip = resolveRefTip(repo, pr.base.ref);
        const headTip = resolveRefTip(repo, pr.head.ref);
        if (baseTip === undefined || headTip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const headTree = commitTreeOid(repo, headTip);
        const baseTree = commitTreeOid(repo, baseTip);
        if (headTree === undefined || baseTree === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const mb = mergeBase(repo.objects, baseTip, headTip);
        const mbTree = mb === null ? null : commitTreeOid(repo, mb) ?? null;
        if (hasMergeConflict(repo, mbTree, headTree, baseTree)) {
          sendError(res, 405, 'Merge conflict');
          return true;
        }
        const message =
          asString(jsonBody['message']) ?? 'Merge pull request #' + pr.number;
        const made = makeCommitObject(repo.objects, headTree, [baseTip], message, store);
        repo.objects.set(made.oid, made.obj);
        repo.refs.set('refs/heads/' + pr.base.ref, made.oid);
        pr.state = 'closed';
        pr.merged = true;
        pr.merged_at = MERGED_AT;
        pr.merge_commit_sha = made.oid;
        sendJson(res, 200, {
          sha: made.oid,
          merged: true,
          message: 'Pull request successfully merged',
        });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // Sub-rute /repos/{o}/{r}/... yang tak dikenal.
    sendError(res, 404, 'Not Found');
    return true;
  }

  // Rute /api/v3/* lain yang tak dikenal.
  sendError(res, 404, 'Not Found');
  return true;
}
