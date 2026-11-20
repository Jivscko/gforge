# gforge — a standalone GitHub-compatible git forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Jivscko/gforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/Jivscko/gforge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A single-process, dependency-free git forge built for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).
It speaks the four surfaces a GitHub client expects, all from one in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (`ls-refs`, `fetch` with shallow/deepen support) with a v0 fallback, and
  receive-pack v0 with `report-status`, `side-band-64k` and `delete-refs`.
  Packfiles are parsed (ofs-delta / ref-delta resolution) and generated
  in-process on `node:zlib` and `node:crypto`; there is no git binary.
  Pushes are fast-forward only, refused per ref with `ng <ref> non-fast-forward`.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (base64, sha-conflict 409), labels, issues, comments, pull requests, their
  files and squash merges. Bearer-token auth, JSON everywhere,
  `X-GitHub-Request-Id` on every reply, `Link` pagination.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send: viewer/repository reads, `__type` introspection,
  issue ordering and cursor pagination, create/close/merge/comment mutations,
  Relay `node(id:)` and operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`) plus the 2025-11-25 handshake era, with `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request` acting on the same store as REST.

## Run it

Node 22, nothing to install:

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle: it binds an ephemeral port, registers it with
the environment at `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done`
until the suite is over and exits 0. `app.ts` builds the HTTP server
(`createApp()`); everything it serves lives in memory and disappears with the
process.

To point the kit's local suite at a running instance:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token "$MAKEFUN_SHOP_TOKEN" --perf
```

## Layout

- `main.ts` — entry lifecycle (kept as the kit ships it)
- `app.ts` — `createApp()`: the HTTP server and router
- `src/git.ts` — git object model, pkt-line codec, packfile read/write
- `src/githttp.ts` — smart-HTTP upload-pack / receive-pack services
- `src/store.ts` — the in-memory forge: repos, refs, issues, pulls, merges
- `src/rest.ts` — REST v3 routes
- `src/graphql.ts` — GraphQL parser, schema and executor
- `src/mcp.ts` — the MCP endpoint and its tools
- `src/identity.ts` — the token owner's login, derived from the contest's public scenario seed

[Enter make.fun](https://make.fun/r/s9rnvy2k)
