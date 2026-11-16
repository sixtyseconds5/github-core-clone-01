# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sixtyseconds5/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sixtyseconds5/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: smart-HTTP git (protocol v2 and v0, shallow clones, packfiles), REST v3, GraphQL and MCP — standard library only, no dependencies, no git binary, no internet. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own; the flag is harmless there and makes an older local Node work too. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. The login that token names is derived from the fixed public scenario seed in `src/scenario.ts` — the same seed the conformance kit ships — so the forge knows its viewer without any configuration.

## Layout

- `main.ts`: the lifecycle above. Kept as the kit's starter ships it.
- `app.ts`: the HTTP server and routing.
- `src/store.ts`: the in-memory forge state (objects, refs, issues, pull requests, merges).
- `src/gitobjs.ts`: git objects, pkt-lines and packfiles.
- `src/githttp.ts`: smart HTTP (advertisement, fetch, push).
- `src/rest.ts`: REST v3.
- `src/graphql.ts`: GraphQL parser and executor.
- `src/mcp.ts`: MCP (streamable HTTP, JSON-RPC 2.0).
- `src/scenario.ts`: the seeded identity derivation.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bny55a6b&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
