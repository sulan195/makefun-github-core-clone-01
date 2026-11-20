// mcp.ts — MCP Streamable HTTP (JSON-RPC) untuk makefun-github-core-clone-01.
// Stdlib Node saja. Endpoint: POST /mcp (lihat ARCHITECTURE.md / spec-mcp-perf.md).
// Mendukung era modern 2026-07-28 (server/discover) + era legacy (initialize,
// notifications/initialized, Mcp-Session-Id), tools/list (6 tool, deterministik),
// tools/call, error -32601/-32602/-32700, dan 401 tanpa Bearer.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Store, Repo, Issue, PullRequest, PullFile } from './store.ts';
import { makeCommitObject, mergeBase, diffTrees, parseCommit, flattenTree } from './gitobj.ts';

// ---------------------------------------------------------------------------
// Util HTTP
// ---------------------------------------------------------------------------

let requestCounter = 0;

function ensureRequestId(res: ServerResponse): void {
  if (!res.hasHeader('X-GitHub-Request-Id')) {
    requestCounter += 1;
    res.setHeader('X-GitHub-Request-Id', `req-mcp-${requestCounter}`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  ensureRequestId(res);
  if (extraHeaders) {
    for (const key of Object.keys(extraHeaders)) res.setHeader(key, extraHeaders[key]);
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendEmpty(res: ServerResponse, status: number, extraHeaders?: Record<string, string>): void {
  ensureRequestId(res);
  if (extraHeaders) {
    for (const key of Object.keys(extraHeaders)) res.setHeader(key, extraHeaders[key]);
  }
  res.writeHead(status);
  res.end();
}

// ---------------------------------------------------------------------------
// Konstanta protokol
// ---------------------------------------------------------------------------

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'session-1';

// ---------------------------------------------------------------------------
// Global id + bentuk REST (dibagi dengan permukaan REST/GraphQL)
// ---------------------------------------------------------------------------

function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function repoHash(repo: Repo): string {
  return sha1Hex(`${repo.owner}/${repo.name}`).slice(0, 16);
}

function repoGlobalId(repo: Repo): string {
  return `R_${sha1Hex(`${repo.owner}/${repo.name}`).slice(0, 20)}`;
}

function issueGlobalId(repo: Repo, number: number): string {
  return `I_${repoHash(repo)}_${number}`;
}

function prGlobalId(repo: Repo, number: number): string {
  return `P_${repoHash(repo)}_${number}`;
}

function repoToRest(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issueToRest(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function prToRest(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: prGlobalId(repo, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
  };
}

// ---------------------------------------------------------------------------
// Git helpers (squash merge + deteksi konflik, lokal — tanpa rest.ts)
// ---------------------------------------------------------------------------

function commitTreeOid(repo: Repo, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (!obj) return null;
  try {
    return parseCommit(obj.data).tree;
  } catch {
    return null;
  }
}

function prFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const headTree = commitTreeOid(repo, headSha);
  const baseTree = commitTreeOid(repo, baseSha);
  if (headTree === null || baseTree === null) return [];
  try {
    return diffTrees(repo.objects, baseTree, headTree);
  } catch {
    return [];
  }
}

function sameEntry(
  a: { oid: string; mode: string } | undefined,
  b: { oid: string; mode: string } | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.oid === b.oid && a.mode === b.mode;
}

function isConflicting(repo: Repo, pr: PullRequest): boolean {
  const base = mergeBase(repo.objects, pr.base.sha, pr.head.sha);
  if (base === null) return false;
  const mbTree = commitTreeOid(repo, base);
  const baseTree = commitTreeOid(repo, pr.base.sha);
  const headTree = commitTreeOid(repo, pr.head.sha);
  if (mbTree === null || baseTree === null || headTree === null) return false;
  let mb: Map<string, { oid: string; mode: string }>;
  let bt: Map<string, { oid: string; mode: string }>;
  let ht: Map<string, { oid: string; mode: string }>;
  try {
    mb = flattenTree(repo.objects, mbTree);
    bt = flattenTree(repo.objects, baseTree);
    ht = flattenTree(repo.objects, headTree);
  } catch {
    return false;
  }
  const paths = new Set<string>([...mb.keys(), ...bt.keys(), ...ht.keys()]);
  for (const path of paths) {
    const m = mb.get(path);
    const b = bt.get(path);
    const h = ht.get(path);
    if (!sameEntry(m, h) && !sameEntry(m, b) && !sameEntry(b, h)) return true;
  }
  return false;
}

// Squash merge: satu commit baru di tip base, tree = tree head, parent = tip base.
function squashMerge(store: Store, repo: Repo, pr: PullRequest): string {
  const headTree = commitTreeOid(repo, pr.head.sha);
  if (headTree === null) throw new Error('head commit not found');
  const message = `Merge pull request #${pr.number} from ${pr.head.ref}`;
  const made = makeCommitObject(repo.objects, headTree, [pr.base.sha], message, store);
  repo.objects.set(made.oid, made.obj);
  repo.refs.set(`refs/heads/${pr.base.ref}`, made.oid);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = '2026-11-20T00:00:00Z';
  pr.merge_commit_sha = made.oid;
  return made.oid;
}

// ---------------------------------------------------------------------------
// Definisi tool (TETAP — dibangun sekali, stringify sama tiap panggilan)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

function okOutcome(value: unknown): ToolOutcome {
  return { isError: false, text: JSON.stringify(value), structured: value };
}

function errOutcome(message: string): ToolOutcome {
  const value = { error: message };
  return { isError: true, text: JSON.stringify(value), structured: value };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const CANONICAL_TOOLS = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];

function canonicalToolName(name: string): string | null {
  const norm = normalizeName(name);
  for (const c of CANONICAL_TOOLS) {
    if (norm === normalizeName(c)) return c;
  }
  for (const c of CANONICAL_TOOLS) {
    if (norm.endsWith(normalizeName(c))) return c;
  }
  return null;
}

function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const v = args[name];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function reqString(args: Record<string, unknown>, names: string[], label: string): string | null {
  const v = pickArg(args, names);
  if (typeof v !== 'string' || v.trim() === '') return null;
  return v;
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = reqString(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'], 'owner');
  let repo = reqString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'], 'repo');
  const fullName = pickArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const parts = fullName.split('/');
    if (!owner) owner = parts[0];
    if (!repo) repo = parts[1];
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const canonical = canonicalToolName(name);
  if (!canonical) return errOutcome(`Unknown tool: ${name}`);
  if (canonical === 'create_repo') {
    const repoName = reqString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name'], 'name');
    if (!repoName) return errOutcome('Missing required argument: name');
    const descriptionRaw = pickArg(args, ['description']);
    const description = typeof descriptionRaw === 'string' ? descriptionRaw : '';
    const privateRaw = pickArg(args, ['private', 'is_private']);
    const isPrivate = privateRaw === true;
    const repo = store.createRepo(store.viewerLogin, repoName, isPrivate, description);
    if (!repo) return errOutcome('Repository already exists.');
    return okOutcome(repoToRest(repo));
  }
  if (canonical === 'get_repo') {
    const target = resolveOwnerRepo(args);
    if (!target) return errOutcome('Missing required argument: owner or repo');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return errOutcome('Repository not found.');
    return okOutcome(repoToRest(repo));
  }
  if (canonical === 'create_issue') {
    const target = resolveOwnerRepo(args);
    if (!target) return errOutcome('Missing required argument: owner or repo');
    const title = reqString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'], 'title');
    if (!title) return errOutcome('Missing required argument: title');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return errOutcome('Repository not found.');
    const bodyRaw = pickArg(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']);
    const body = typeof bodyRaw === 'string' ? bodyRaw : '';
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const issue: Issue = {
      number,
      title,
      body,
      state: 'open',
      labels: [],
      comments: [],
      seq: store.seq,
    };
    store.seq += 1;
    repo.issues.set(number, issue);
    return okOutcome(issueToRest(repo, issue));
  }
  if (canonical === 'list_issues') {
    const target = resolveOwnerRepo(args);
    if (!target) return errOutcome('Missing required argument: owner or repo');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return errOutcome('Repository not found.');
    const stateRaw = pickArg(args, ['state', 'status']);
    const state = typeof stateRaw === 'string' ? stateRaw.toLowerCase() : 'all';
    let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    const value = { issues: list.map((issue) => issueToRest(repo, issue)) };
    return okOutcome(value);
  }
  if (canonical === 'create_pull_request') {
    const target = resolveOwnerRepo(args);
    if (!target) return errOutcome('Missing required argument: owner or repo');
    const title = reqString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'], 'title');
    if (!title) return errOutcome('Missing required argument: title');
    const head = reqString(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from', 'from_branch', 'branch'], 'head');
    if (!head) return errOutcome('Missing required argument: head');
    const base = reqString(args, ['base', 'base_ref', 'base_branch', 'target', 'target_ref', 'into', 'into_branch'], 'base');
    if (!base) return errOutcome('Missing required argument: base');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return errOutcome('Repository not found.');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return errOutcome('Branch not found.');
    const number = repo.nextPull;
    repo.nextPull += 1;
    const pr: PullRequest = {
      number,
      title,
      body: '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      files: [],
      seq: store.seq,
    };
    store.seq += 1;
    pr.files = prFiles(repo, baseSha, headSha);
    repo.pulls.set(number, pr);
    return okOutcome(prToRest(repo, pr));
  }
  if (canonical === 'merge_pull_request') {
    const target = resolveOwnerRepo(args);
    if (!target) return errOutcome('Missing required argument: owner or repo');
    const pullRaw = pickArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
    const pullNumber = typeof pullRaw === 'number' ? pullRaw : typeof pullRaw === 'string' ? Number(pullRaw) : NaN;
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
      return errOutcome('Missing required argument: pull_number');
    }
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return errOutcome('Repository not found.');
    const pr = repo.pulls.get(pullNumber);
    if (!pr) return errOutcome('Pull request not found.');
    if (pr.merged) {
      return okOutcome({ sha: pr.merge_commit_sha, merged: true, message: `Pull request #${pr.number} already merged.` });
    }
    if (pr.state !== 'open') return errOutcome('Pull request is closed.');
    if (isConflicting(repo, pr)) return errOutcome('Merge conflict.');
    const sha = squashMerge(store, repo, pr);
    return okOutcome({ sha, merged: true, message: `Pull request #${pr.number} merged.` });
  }
  return errOutcome(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

function rpcResult(
  res: ServerResponse,
  id: unknown,
  result: unknown,
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
}

function rpcError(
  res: ServerResponse,
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, 200, { jsonrpc: '2.0', id, error });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function requestedProtocolVersion(msg: Record<string, unknown>): string | undefined {
  const params = asRecord(msg.params);
  const metas: unknown[] = [msg._meta, params._meta];
  for (const meta of metas) {
    const rec = asRecord(meta);
    const v = rec['io.modelcontextprotocol/protocolVersion'];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string | undefined,
  body: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/mcp') return false;
  if (req.method !== 'POST' && req.method !== 'DELETE') return false;
  const auth = req.headers.authorization ?? '';
  if (!token || auth !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  if (req.method === 'DELETE') {
    sendEmpty(res, 202);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const msg = parsed as Record<string, unknown>;
  const hasId = 'id' in msg && msg.id !== undefined && msg.id !== null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  // Notifikasi (tanpa id) atau method notifications/* -> 202, body kosong.
  if (!hasId || method.startsWith('notifications/')) {
    sendEmpty(res, 202);
    return true;
  }
  const id = msg.id;
  const params = asRecord(msg.params);
  if (method === 'server/discover') {
    const requested = requestedProtocolVersion(msg);
    if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
      rpcError(res, id, -32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS });
      return true;
    }
    rpcResult(res, id, {
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
    rpcResult(
      res,
      id,
      {
        protocolVersion: negotiated,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      },
      { 'Mcp-Session-Id': SESSION_ID },
    );
    return true;
  }
  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments);
    if (!name) {
      rpcError(res, id, -32602, 'Missing tool name.');
      return true;
    }
    if (canonicalToolName(name) === null) {
      rpcError(res, id, -32602, `Unknown tool: ${name}`);
      return true;
    }
    const outcome = callTool(store, name, args);
    const result: Record<string, unknown> = {
      content: [{ type: 'text', text: outcome.text }],
      structuredContent: outcome.structured,
    };
    if (outcome.isError) result.isError = true;
    rpcResult(res, id, result);
    return true;
  }
  if (method === 'ping') {
    rpcResult(res, id, {});
    return true;
  }
  rpcError(res, id, -32601, `Method not found: ${method}`);
  return true;
}
