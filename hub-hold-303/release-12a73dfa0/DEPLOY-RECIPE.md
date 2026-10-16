# Deploy recipe: T3 Code 0.1.0 + hanan-work#303 patch set, build 2 (12a73dfa0)

Source commit `12a73dfa0d5752bd3560f778715926da87881b8e` = upstream v0.1.0 81493efb7 + the 16 patches on
hanan-work#817 head 3f9f91a3 (Opus GO). Version stamp `0.1.0-hh303-12a73dfa0`.
Gate on 12a73dfa0: 4 files, 103/103 (LegacyDispatch, HubHold, selfUpdate, serverSettings).

## Artifacts (t2: ~/work/hh303/release/0.1.0-hh303-12a73dfa0/, sums in SHA256SUMS)
| file | sha256 | use |
|---|---|---|
| `t3-overlay-0.1.0-hh303-12a73dfa0.tgz` | `37c346b08a9fe1d6e036681d7a1dfc583fdbd42210d7acd19af02eecede358b6` | **the deploy artifact**: `bin.mjs` (self-contained, `effect` inlined) + `client/`. Platform-independent. |
| ↳ `bin.mjs` inside it | `e7dbfb585e29067603b088d8603720341c6c2b3d3503cbd6a627b99d2b4798ee` | the `runtime.bundleSha256` readback value |
| `t3-linux-x64-sea-0.1.0-hh303-12a73dfa0` | `b988c6107a38789d32ee20ea3f3478578a8b9f143c4a0edbc67cdce01c4919bb` | optional linux-x64 single executable (Node 26.8.2, same as stock). Readback shows `bundleSha256: null` under it (fixed in follow-up commit fb36f0555, not in build 2), so prefer the node shape. |
| `t3-server-0.1.0-hh303-12a73dfa0.tgz` | `f67a8f4e…` | **do not deploy**: `dist/` needs `effect` in node_modules, which the stock platform package lacks. |

## How stock 0.1.0 is laid out
`node_modules/t3/bin/t3.js` (launcher) execs `node_modules/@t3code/t3-<platform>/t3`, a Node 26.8.2 single
executable with the app inside. Beside it: `client/` (web UI), `resource-monitor/`, and `node_modules/` holding only
the runtime externals: node-pty, @napi-rs/keyring(+platform), @ff-labs/fff-node + ffi-rs(+platform), @cursor/sdk
(+platform), playwright-core, undici, zod, connectrpc, statsig. **All native addons are N-API** (`napi_register_module`,
no `node_register_module_v*`), so they are not tied to the SEA's Node ABI.

## Recipe (both platforms): run our bin.mjs with node beside the stock platform package
On the target, with the stock 0.1.0 install at `$T3` (e.g. `~/.local/share/t3-upgrade/staging/0.1.0`) and
`PKG=$T3/node_modules/@t3code/t3-<linux-x64|darwin-arm64>`:
1. Keep stock as the rollback: do NOT touch `$PKG/t3` or the launcher.
2. `tar -xzf t3-overlay-0.1.0-hh303-12a73dfa0.tgz -C <new dir D>` → `D/bin.mjs`, `D/client/`.
3. `ln -s $PKG/node_modules D/node_modules` and `ln -s $PKG/resource-monitor D/resource-monitor`
   (bin.mjs resolves natives, client/ and resource-monitor/ beside itself; proven with bin.mjs copied into `$PKG` too).
4. Service command: `node D/bin.mjs serve …` (same flags/env as today), with Node **≥ 24.13 (engines), N-API 10**.
   Proven with Node 24.21.0 (ABI 137) and 26.8.2 (ABI 147).
5. Env: add the three **public** cloud values (below), plus whatever the service already sets.
6. Settings: write `"continueThreadsAfterServerUpdate": false` explicitly (the import-time default only fires on a
   0.0.x database; a hub already on stock 0.1.0 has `true`).
7. Readback (scope `orchestration:read`): `GET /api/orchestration/inventory` → `runtime.version`
   `0.1.0-hh303-12a73dfa0`, `runtime.bundleSha256` `e7dbfb585e29067603b088d8603720341c6c2b3d3503cbd6a627b99d2b4798ee`,
   `continueThreadsAfterServerUpdate.global false`, `hold.held false`. Then compat: `POST /api/orchestration/dispatch` with an existing dispatcher request → 200.
8. Rollback = point the service back at stock `$T3/node_modules/.bin/t3` (unchanged files). The DB is shared; our
   only schema change is migration 063 (two new tables), harmless to stock 0.1.0.

## Proofs on t2 (linux-x64), scratch copy of the staged stock install (staging itself untouched)
Scratch: `~/work/hh303/scratch-linux/0.1.0` (cp -a of `~/.local/share/t3-upgrade/staging/0.1.0`), throwaway base-dirs,
spare loopback ports, systemd-run units, all stopped afterwards.
- **Natives under plain node** (`native-load.cjs <PKG>`): node-pty (loads + spawns a pty, output `pty-ok`),
  @napi-rs/keyring, @ff-labs/fff-node all `ok` under **Node 24.21.0 (ABI 137, N-API 10)** and **26.8.2 (ABI 147)**.
- **Shape B, node + overlay bin.mjs beside stock node_modules** (`boot-check.sh`), Node 26.8.2 and 24.21.0 each:
  up in 4 s; inventory `version 0.1.0-hh303-12a73dfa0`, `bundleSha256 e7dbfb585e29067603b088d8603720341c6c2b3d3503cbd6a627b99d2b4798ee`,
  `continueThreadsAfterServerUpdate.global false`; compat `thread.create` **200**, idle `thread.turn.interrupt` **200**;
  hub-hold read 200.
- **Shape A, stock launcher → our linux SEA swapped in**: same results except `bundleSha256 null` (SEA has no .mjs
  entry; a follow-up commit hashes the executable instead).
- **Cloud config**: `t3 connect status` on a throwaway base-dir:
  stock binary and our build *with* the three public env values print the identical status
  ("T3 Connect … Next: Run `t3 connect link` …"); our build *without* them prints
  "T3 Connect is unavailable in builds without public configuration." So the env is required and sufficient.

## Relay / Clerk config (item 2)
The stock binary has them **baked in at build time** (vite `define` → `buildTimeRelayUrl`,
`buildTimeClerkPublishableKey`, `buildTimeClerkCliOAuthClientId` in `cloud/publicConfig.ts`); runtime env overrides.
Our build is not built with them, so set as env (values read from the stock 0.1.0 binary; all public client values):
```
T3CODE_RELAY_URL=https://relay.t3.codes
T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r
```
(`T3CODE_HOSTED_APP_URL` has an in-code default, same as stock.)
**Not copied, treat as secret**: the stock build also bakes a relay-client OTLP traces *token* (upstream CI masks it).
It only enables optional relay-client tracing; leave it unset. Do not put it in files or chat.
**Pairing proof after the swap (on each target)**: before the swap record `t3 connect status` and
`GET /api/connect/link-state`; after the swap both must read the same linked state (the link lives in the state dir,
not the binary); the server log must not say "unavailable in builds without public configuration"; then Scott opens
that environment from the phone app and sends one message. A scratch base-dir on t2 has no linked account, so the
live phone check can only happen on a target.

## darwin-arm64 (M2) (item 3)
The M2's `@t3code/t3-darwin-arm64` ships the same externals as linux-x64 in darwin-arm64 builds
(`package-lock.m2-darwin.json`: node-pty 1.2.0-beta.15, @napi-rs/keyring-darwin-arm64 1.3.0,
@ff-labs/fff-bin-darwin-arm64 0.11.0, @yuuang/ffi-rs-darwin-arm64 1.3.7, @cursor/sdk-darwin-arm64 1.0.35), all N-API.
**Yes, node can use that node_modules**, with a darwin-arm64 Node ≥ 24.13 (N-API 10). Same recipe as above with
`PKG=…/@t3code/t3-darwin-arm64` and the same `t3-overlay` tarball (bin.mjs and client/ are platform-independent).
Prove on the M2 before switching (t2 cannot run darwin binaries):
`node native-load.cjs $PKG` (expects 3× ok + `pty-ok`), then `boot-check.sh m2 <spare port> $D node $D/bin.mjs`.
A darwin SEA (shape A) would have to be built on macOS (`node apps/server/scripts/cli.ts build-exe` with Node ≥ 25.7)
and codesigned; not needed for the node shape.

## Helper scripts (beside this file)
`native-load.cjs` (native addon load + pty spawn), `boot-check.sh` (boot, readback, compat dispatch, stop),
`env-desc.sh`, `t3.mjs` (HTTP client used by boot-check), `public-cloud.env` (the three public values).
