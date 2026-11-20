# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sulan195/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sulan195/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for make.fun's **github-core-clone-01**: a standalone, GitHub-compatible
git forge that runs as one process and serves all four surfaces agents already
speak — git smart HTTP, the REST v3 API, GraphQL v4, and MCP — from its own
in-memory store, with no UI, no outside service, and no git binary.

## Run it

```sh
node main.ts
```

Node 22.18 or later, nothing to install: the program imports only Node built-ins
and its own modules. In a trial the platform runs `node /bot/main.ts` with
`MAKEFUN_ENV_URL` (the env's origin) and `MAKEFUN_SHOP_TOKEN` (the bearer token
every API call presents) in the environment.

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; never
   bind 8080 — that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok": true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, server/discover, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message": "Not Found"}` |

## How it is built

- `store.ts` — the in-memory model: repositories, refs, git objects, issues,
  labels, comments, pull requests. All four surfaces share this one store, so
  an object created over MCP reads back over REST with the same ids.
- `gitobj.ts` — the git object model: SHA-1 ids, commit/tree/tag formats,
  packfile v2/v3 reading (OFS_DELTA and REF_DELTA resolution) and writing,
  reachability, tree diffing, merge-base and ancestry.
- `githttp.ts` — pkt-line framing, v0/v2 advertisements, `ls-refs`, fetch
  (v2 and the v0 fallback, shallow/deepen), receive-pack with per-ref
  fast-forward checks and `report-status` over sideband.
- `rest.ts` — REST v3: repos, branches, commits, contents (base64, stale-sha
  409), labels, issues, comments, pull requests, squash merges with
  conflict detection (405).
- `graphql.ts` — a small GraphQL parser and executor for the exact documents
  `gh` and `github-mcp-server` send, including introspection, cursor
  pagination, batched operations, and the five mutations.
- `mcp.ts` — MCP over streamable HTTP: the 2026-07-28 era via
  `server/discover` plus the legacy `initialize` handshake, six tools, and
  JSON-RPC errors.
- `http.ts` — shared helpers: JSON replies with `X-GitHub-Request-Id`, body
  reading with a byte cap, bearer-token checks.
- `app.ts` — the router; `main.ts` — the entry/env lifecycle (unchanged from
  the kit's starter).

## Determinism

The forge mints no timestamps from the wall clock and uses no unseeded
randomness: commit times come from a counter-based epoch
(`1700000000 + seq`), request ids are a counter, and global ids are hashes of
stable names. Two runs that perform the same operations in the same order
produce the same objects, so a replayed trial leaves the same state.

## Layout

```
main.ts        entry / env lifecycle
app.ts         router
http.ts        JSON replies, body reading, auth helpers
store.ts       the shared in-memory store
gitobj.ts      git objects + packfiles
githttp.ts     git smart HTTP
rest.ts        REST v3
graphql.ts     GraphQL v4
mcp.ts         MCP
```

## License

MIT — see [LICENSE](LICENSE).
