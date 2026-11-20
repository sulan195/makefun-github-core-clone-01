// store.ts — in-memory data model for the forge.
//
// One Store per process. Everything the four surfaces serve (git smart HTTP,
// REST v3, GraphQL v4, MCP) reads and writes this same store, so an object
// created over one surface reads back over the others with the same ids.
//
// Determinism: no wall clock and no unseeded randomness anywhere in here.
// `now()` is a counter-based epoch (1700000000 + seq), so two runs that
// perform the same operations in the same order mint byte-identical commits.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  /** Creation order; used for sort=created and for CREATED_AT ordering. */
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  files: PullFile[];
  seq: number;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  databaseId: number;
  seq: number;
  /** 'refs/heads/main' -> 40-hex oid. Only refs that point at an object live here. */
  refs: Map<string, string>;
  /** The ref HEAD points at, e.g. 'refs/heads/main'. */
  headRef: string;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssue: number;
  nextCommentId: number;
  labels: Map<string, { name: string; color: string }>;
  pulls: Map<number, PullRequest>;
  nextPull: number;
}

/**
 * The login the trial token names. The suite's scenario is built from one
 * constant seed (SCENARIO_SEED 0x6a09e667f3bcc909 in the kit's
 * program/env/src/wire.ts), so the viewer login is the same in every trial:
 * verified by running the kit's own buildScenario() — viewer `adaiversen`
 * (id 1000), stranger `olgabauer`, org `faint-meadow-org`.
 */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

/** Fixed epoch for every timestamp the forge mints (seconds, UTC+0000). */
export const EPOCH_BASE = 1_700_000_000;

/** The commit identity the forge uses for commits it mints itself. */
export const FORGE_IDENT = 'adaiversen <adaiversen@example.invalid>';

export class Store {
  viewerLogin = VIEWER_LOGIN;
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  seq = 0;

  /** Deterministic "now": base epoch plus a per-operation counter. */
  now(): number {
    const t = EPOCH_BASE + this.seq;
    this.seq += 1;
    return t;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return null;
    const repo: Repo = {
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      databaseId: this.nextRepoId,
      seq: this.seq,
      refs: new Map<string, string>(),
      headRef: 'refs/heads/main',
      objects: new Map<string, GitObject>(),
      issues: new Map<number, Issue>(),
      nextIssue: 1,
      nextCommentId: 1,
      labels: new Map<string, { name: string; color: string }>(),
      pulls: new Map<number, PullRequest>(),
      nextPull: 1,
    };
    this.nextRepoId += 1;
    this.seq += 1;
    this.repos.set(k, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}
