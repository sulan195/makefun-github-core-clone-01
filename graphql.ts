// graphql.ts — GraphQL v4 (mini-parser + executor) untuk makefun-github-core-clone-01.
// Stdlib Node saja. Endpoint: POST /api/graphql (lihat ARCHITECTURE.md / spec-graphql.md).
// Menangani 18 dokumen operasi suite: query viewer/repository/node/__type/issues/PR,
// mutasi createIssue/closeIssue/createPullRequest/mergePullRequest/addComment,
// batching (array JSON), introspeksi, dan error unknown-field / unknown-repo / 401.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Store, Repo, Issue, PullRequest, IssueComment, PullFile } from './store.ts';
import { makeCommitObject, mergeBase, diffTrees, parseCommit, flattenTree } from './gitobj.ts';

// ---------------------------------------------------------------------------
// Util HTTP
// ---------------------------------------------------------------------------

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (!res.hasHeader('X-GitHub-Request-Id')) {
    requestCounter += 1;
    res.setHeader('X-GitHub-Request-Id', `req-graphql-${requestCounter}`);
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Global id (opaque, stabil) — lihat ARCHITECTURE.md
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

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return `C_${repoHash(repo)}_${issueNumber}_${commentId}`;
}

function findRepoByHash(store: Store, hash: string): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repoHash(repo) === hash) return repo;
  }
  return undefined;
}

function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  if (!id.startsWith('R_')) return undefined;
  for (const repo of store.repos.values()) {
    if (repoGlobalId(repo) === id) return repo;
  }
  return undefined;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const m = /^I_([0-9a-f]{16})_(\d+)$/.exec(id);
  if (!m) return null;
  const repo = findRepoByHash(store, m[1]);
  if (!repo) return null;
  const issue = repo.issues.get(Number(m[2]));
  if (!issue) return null;
  return { repo, issue };
}

function findPrByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | null {
  const m = /^P_([0-9a-f]{16})_(\d+)$/.exec(id);
  if (!m) return null;
  const repo = findRepoByHash(store, m[1]);
  if (!repo) return null;
  const pr = repo.pulls.get(Number(m[2]));
  if (!pr) return null;
  return { repo, pr };
}

// ---------------------------------------------------------------------------
// Nilai runtime (wrapper ber-__typename)
// ---------------------------------------------------------------------------

interface ObjValue {
  __typename: string;
  [key: string]: unknown;
}

function wrap(typename: string, fields: Record<string, unknown>): ObjValue {
  const out: ObjValue = { __typename: typename };
  for (const key of Object.keys(fields)) out[key] = fields[key];
  return out;
}

function repoValue(repo: Repo): ObjValue {
  return wrap('Repository', { repo });
}

function issueValue(repo: Repo, issue: Issue): ObjValue {
  return wrap('Issue', { repo, issue });
}

function prValue(repo: Repo, pr: PullRequest): ObjValue {
  return wrap('PullRequest', { repo, pr });
}

function userValue(login: string): ObjValue {
  return wrap('User', { login });
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function pageInfoValue(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): ObjValue {
  return wrap('PageInfo', { hasNextPage, hasPreviousPage: false, endCursor, startCursor });
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

function prFiles(repo: Repo, pr: PullRequest): PullFile[] {
  const headTree = commitTreeOid(repo, pr.head.sha);
  const baseTree = commitTreeOid(repo, pr.base.sha);
  if (headTree === null || baseTree === null) return pr.files;
  try {
    return diffTrees(repo.objects, baseTree, headTree);
  } catch {
    return pr.files;
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
    // Diubah di head (vs merge-base) DAN diubah di base (vs merge-base)
    // dengan isi akhir berbeda -> konflik.
    if (!sameEntry(m, h) && !sameEntry(m, b) && !sameEntry(b, h)) return true;
  }
  return false;
}

function computeMergeable(repo: Repo, pr: PullRequest): string {
  if (pr.state !== 'open') return 'UNKNOWN';
  return isConflicting(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
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
// Introspeksi (__type)
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: string;
  fields: string[];
  enumValues: string[];
}

const INTROSPECTION: Record<string, TypeInfo> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    ],
    enumValues: [],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'USER', 'REPOSITORY'] },
};

// ---------------------------------------------------------------------------
// Lexer GraphQL mini
// ---------------------------------------------------------------------------

interface Token {
  kind: string;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Syntax Error: Unterminated block string.');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'u') {
            const hex = src.slice(j + 2, j + 6);
            out += String.fromCharCode(parseInt(hex, 16));
            j += 4;
          } else if (e !== undefined) out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.') {
      if (src.startsWith('...', i)) {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      throw new Error('Syntax Error: Unexpected character ".".');
    }
    if (ch === '!' || ch === '$' || ch === '(' || ch === ')' || ch === ':' || ch === '=' ||
        ch === '@' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '|' ||
        ch === '&') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '-' && i + 1 < src.length && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
      let j = i;
      while (
        j < src.length &&
        ((src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= 'a' && src[j] <= 'z') ||
          (src[j] >= '0' && src[j] <= '9') || src[j] === '_')
      ) {
        j += 1;
      }
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character "${ch}".`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser GraphQL mini (AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  kind: 'operation';
  operation: string;
  name: string | null;
  variables: { name: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  tokens: Token[];
  pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token {
    return this.tokens[this.pos];
  }

  next(): Token {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }

  isPunct(value: string): boolean {
    const tok = this.peek();
    return tok.kind === 'punct' && tok.value === value;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`Syntax Error: Expected "${value}", found "${tok.value}".`);
    }
  }

  expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') {
      throw new Error(`Syntax Error: Expected Name, found "${tok.value}".`);
    }
    return tok.value;
  }

  skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  // Lewati definisi tipe variabel, mis. String!, [IssueState!], Int.
  skipType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push(this.parseOperationShorthand());
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        operations.push(this.parseOperation());
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        const frag = this.parseFragment();
        fragments.set(frag.name, frag);
      } else {
        throw new Error(`Syntax Error: Unexpected token "${tok.value}".`);
      }
    }
    return { operations, fragments };
  }

  parseOperationShorthand(): OperationNode {
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation: 'query', name: null, variables: [], selections };
  }

  parseOperation(): OperationNode {
    const opTok = this.next();
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    let variables: { name: string; defaultValue: ValueNode | null }[] = [];
    if (this.isPunct('(')) variables = this.parseVariableDefinitions();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation: opTok.value, name, variables, selections };
  }

  parseVariableDefinitions(): { name: string; defaultValue: ValueNode | null }[] {
    const defs: { name: string; defaultValue: ValueNode | null }[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.skipType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  parseFragment(): FragmentNode {
    this.next(); // 'fragment'
    const name = this.expectName();
    const onTok = this.next();
    if (onTok.kind !== 'name' || onTok.value !== 'on') {
      throw new Error('Syntax Error: Expected "on" in fragment definition.');
    }
    const typeCondition = this.expectName();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selections };
  }

  parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated selection set.');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const tok = this.peek();
      if (tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, selections };
      }
      if (tok.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      const selections = this.parseSelectionSet();
      return { kind: 'inline', typeCondition: null, selections };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.isPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) {
        if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated list.');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated object.');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: parseFloat(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Syntax Error: Unexpected value token "${tok.value}".`);
  }
}

function parseDocument(tokens: Token[]): DocumentNode {
  return new Parser(tokens).parseDocument();
}

// ---------------------------------------------------------------------------
// Eksekusi
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, FragmentNode>;
}

const KNOWN_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ]),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  PullRequest: new Set(['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PullRequestConnection: new Set(['nodes', 'pageInfo']),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo']),
  PullRequestChangedFile: new Set(['path']),
  User: new Set(['login']),
  Ref: new Set(['name']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  IssueCommentEdge: new Set(['node']),
  IssueComment: new Set(['id', 'body']),
};

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return undefined;
}

function buildIssuesConnection(repo: Repo, args: Record<string, unknown>): ObjValue {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = asRecord(args.orderBy);
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  list.sort((a, b) => {
    const bySeq = (a.seq - b.seq) * direction;
    if (bySeq !== 0) return bySeq;
    return (a.number - b.number) * direction;
  });
  const afterNumber = decodeCursor(args.after);
  let start = 0;
  if (afterNumber !== null) {
    const idx = list.findIndex((issue) => issue.number === afterNumber);
    start = idx === -1 ? 0 : idx + 1;
  }
  const first = asInt(args.first);
  const page = first === undefined ? list.slice(start) : list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return wrap('IssueConnection', {
    nodes: page.map((issue) => issueValue(repo, issue)),
    pageInfo: pageInfoValue(hasNextPage, endCursor, startCursor),
  });
}

function buildPullRequestsConnection(repo: Repo, args: Record<string, unknown>): ObjValue {
  const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const first = asInt(args.first);
  const page = first === undefined ? list : list.slice(0, first);
  const hasNextPage = page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return wrap('PullRequestConnection', {
    nodes: page.map((pr) => prValue(repo, pr)),
    pageInfo: pageInfoValue(hasNextPage, endCursor, startCursor),
  });
}

function buildFilesConnection(repo: Repo, pr: PullRequest, args: Record<string, unknown>): ObjValue {
  const files = prFiles(repo, pr);
  const first = asInt(args.first);
  const page = first === undefined ? files : files.slice(0, first);
  const hasNextPage = page.length < files.length;
  return wrap('PullRequestChangedFileConnection', {
    nodes: page.map((f) => wrap('PullRequestChangedFile', { path: f.filename })),
    pageInfo: pageInfoValue(hasNextPage, null, null),
  });
}

function decodeNode(store: Store, id: string): ObjValue | null {
  if (id.startsWith('R_')) {
    const repo = findRepoByGlobalId(store, id);
    return repo ? repoValue(repo) : null;
  }
  if (id.startsWith('I_')) {
    const found = findIssueByGlobalId(store, id);
    return found ? issueValue(found.repo, found.issue) : null;
  }
  if (id.startsWith('P_')) {
    const found = findPrByGlobalId(store, id);
    return found ? prValue(found.repo, found.pr) : null;
  }
  return null;
}

function fieldValue(typename: string, value: ObjValue, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const args = resolveArgs(field, ctx);
  switch (typename) {
    case 'Query': {
      if (field.name === 'viewer') return userValue(store.viewerLogin);
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = store.getRepo(owner, name);
        return repo ? repoValue(repo) : null;
      }
      if (field.name === 'node') {
        return decodeNode(store, String(args.id ?? ''));
      }
      if (field.name === '__type') {
        const info = INTROSPECTION[String(args.name ?? '')];
        if (!info) return null;
        return wrap('__Type', {
          name: String(args.name ?? ''),
          kind: info.kind,
          fields: info.fields.map((n) => wrap('__Field', { name: n })),
          enumValues: info.enumValues.map((n) => wrap('__EnumValue', { name: n })),
        });
      }
      return null;
    }
    case 'Mutation': {
      return mutationValue(field, args, ctx);
    }
    case 'Repository': {
      const repo = value.repo as Repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.databaseId;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return userValue(repo.owner);
      if (field.name === 'defaultBranchRef') return wrap('Ref', { name: repo.defaultBranch });
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = asInt(args.number);
        if (number === undefined) return null;
        const issue = repo.issues.get(number);
        return issue ? issueValue(repo, issue) : null;
      }
      if (field.name === 'issues') return buildIssuesConnection(repo, args);
      if (field.name === 'pullRequests') return buildPullRequestsConnection(repo, args);
      if (field.name === 'pullRequest') {
        const number = asInt(args.number);
        if (number === undefined) return null;
        const pr = repo.pulls.get(number);
        return pr ? prValue(repo, pr) : null;
      }
      return null;
    }
    case 'Issue': {
      const repo = value.repo as Repo;
      const issue = value.issue as Issue;
      if (field.name === 'id') return issueGlobalId(repo, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      return null;
    }
    case 'PullRequest': {
      const repo = value.repo as Repo;
      const pr = value.pr as PullRequest;
      if (field.name === 'id') return prGlobalId(repo, pr.number);
      if (field.name === 'number') return pr.number;
      if (field.name === 'state') return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pr.merged;
      if (field.name === 'headRefName') return pr.head.ref;
      if (field.name === 'baseRefName') return pr.base.ref;
      if (field.name === 'mergeable') return computeMergeable(repo, pr);
      if (field.name === 'files') return buildFilesConnection(repo, pr, args);
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return value.nodes;
      if (field.name === 'pageInfo') return value.pageInfo;
      return null;
    }
    case '__Type': {
      if (field.name === 'name') return value.name;
      if (field.name === 'kind') return value.kind;
      if (field.name === 'fields') return value.fields;
      if (field.name === 'enumValues') return value.enumValues;
      return null;
    }
    default: {
      // Passthrough untuk tipe sederhana: User, Ref, PageInfo, __Field,
      // __EnumValue, PullRequestChangedFile, payload mutasi, edge, komentar.
      if (field.name in value) {
        const v = value[field.name];
        return v === undefined ? null : v;
      }
      return null;
    }
  }
}

function mutationValue(field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = asRecord(args.input);
  if (field.name === 'createIssue') {
    const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const issue: Issue = {
      number,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: store.seq,
    };
    store.seq += 1;
    repo.issues.set(number, issue);
    return wrap('CreateIssuePayload', { issue: issueValue(repo, issue) });
  }
  if (field.name === 'closeIssue') {
    const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Issue not found.' });
      return null;
    }
    found.issue.state = 'closed';
    return wrap('CloseIssuePayload', { issue: issueValue(found.repo, found.issue) });
  }
  if (field.name === 'createPullRequest') {
    const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'Branch not found.' });
      return null;
    }
    const number = repo.nextPull;
    repo.nextPull += 1;
    const draft: PullRequest = {
      number,
      title: String(input.title ?? ''),
      body: '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      files: [],
      seq: store.seq,
    };
    store.seq += 1;
    draft.files = prFiles(repo, draft);
    repo.pulls.set(number, draft);
    return wrap('CreatePullRequestPayload', { pullRequest: prValue(repo, draft) });
  }
  if (field.name === 'mergePullRequest') {
    const found = findPrByGlobalId(store, String(input.pullRequestId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Pull request not found.' });
      return null;
    }
    const { repo, pr } = found;
    if (!pr.merged) {
      if (pr.state !== 'open') {
        ctx.errors.push({ message: 'Pull request is closed.' });
        return null;
      }
      if (isConflicting(repo, pr)) {
        ctx.errors.push({ message: 'Merge conflict.' });
        return null;
      }
      squashMerge(store, repo, pr);
    }
    return wrap('MergePullRequestPayload', { pullRequest: prValue(repo, pr) });
  }
  if (field.name === 'addComment') {
    const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Issue not found.' });
      return null;
    }
    const commentId = found.repo.nextCommentId;
    found.repo.nextCommentId += 1;
    const comment: IssueComment = { id: commentId, body: String(input.body ?? '') };
    found.issue.comments.push(comment);
    const node = wrap('IssueComment', {
      id: commentGlobalId(found.repo, found.issue.number, commentId),
      body: comment.body,
    });
    return wrap('AddCommentPayload', {
      commentEdge: wrap('IssueCommentEdge', { node }),
    });
  }
  return null;
}

function resolveField(typename: string, value: ObjValue, field: FieldNode, ctx: Ctx): unknown {
  if (field.name === '__typename') return typename;
  const known = KNOWN_FIELDS[typename];
  if (!known || !known.has(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
    return null;
  }
  const raw = fieldValue(typename, value, field, ctx);
  if (raw === null || raw === undefined) return null;
  if (!field.selections) return raw;
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (item !== null && typeof item === 'object' && typeof (item as ObjValue).__typename === 'string') {
        return resolveSelection((item as ObjValue).__typename, item as ObjValue, field.selections as SelectionNode[], ctx);
      }
      return item;
    });
  }
  if (typeof raw === 'object' && typeof (raw as ObjValue).__typename === 'string') {
    return resolveSelection((raw as ObjValue).__typename, raw as ObjValue, field.selections, ctx);
  }
  return raw;
}

function resolveSelection(
  typename: string,
  value: ObjValue,
  selections: SelectionNode[],
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      out[key] = resolveField(typename, value, sel, ctx);
    } else if (sel.kind === 'inline') {
      if (!sel.typeCondition || sel.typeCondition === typename) {
        Object.assign(out, resolveSelection(typename, value, sel.selections, ctx));
      }
    } else if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag && frag.typeCondition === typename) {
        Object.assign(out, resolveSelection(typename, value, frag.selections, ctx));
      }
    }
  }
  return out;
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function runOperation(store: Store, op: unknown): OperationResult {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    return { data: null, errors: [{ message: 'Expected a JSON object for one operation.' }] };
  }
  const rec = op as Record<string, unknown>;
  if (typeof rec.query !== 'string') {
    return { data: null, errors: [{ message: 'Missing or invalid "query".' }] };
  }
  const variables =
    rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables)
      ? (rec.variables as Record<string, unknown>)
      : {};
  let doc: DocumentNode;
  try {
    doc = parseDocument(tokenize(rec.query));
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error.' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document.' }] };
  }
  let operation = doc.operations[0];
  if (typeof rec.operationName === 'string') {
    const found = doc.operations.find((o) => o.name === rec.operationName);
    if (found) operation = found;
  }
  const ctx: Ctx = { store, variables, errors: [], fragments: doc.fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelection(rootType, { __typename: rootType }, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string | undefined,
  body: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/graphql') return false;
  if (req.method !== 'POST') return false;
  const auth = req.headers.authorization ?? '';
  if (!token || auth !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON body.' });
    return true;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(res, 400, { message: 'Empty batch.' });
      return true;
    }
    const results = parsed.map((op) => runOperation(store, op));
    sendJson(res, 200, results);
    return true;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { message: 'Expected a JSON object or array.' });
    return true;
  }
  if (typeof (parsed as Record<string, unknown>).query !== 'string') {
    sendJson(res, 400, { message: 'Missing or invalid "query".' });
    return true;
  }
  sendJson(res, 200, runOperation(store, parsed));
  return true;
}
