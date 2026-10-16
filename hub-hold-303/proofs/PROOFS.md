# hanan-work#303 proofs (D-20261016-02), scratch 0.1.0 hub on t2

Branch feat/hub-hold-303 @ 8c5e6f32e on v0.1.0 81493efb7, run from source (`node apps/server/src/bin.ts serve`),
scratch T3CODE_HOME, loopback port 47303, ACP mock provider with T3_ACP_HANG_PROMPT_FOREVER=1.
Evidence of what reached a provider: the mock's request log (`session/prompt` count and message text).
Driven by `hub.sh` (start/stop/kill) and `t3.mjs` (HTTP, v2 WS RPC, read-only sqlite).

## (a) restart with queued + in-flight turns: PASS  (10-16 05:24-05:32 PT)
Thread A, 3 turns via the compat `POST /api/orchestration/dispatch`; continueThreadsAfterServerUpdate=false.
| step | runs | prompts | inventory counts |
|---|---|---|---|
| before | running, queued(1), queued(2) | 1 | queued 2, inFlight 1 |
| graceful restart | cancelled, queued held(1), queued held(2) | 1 | held 2, inFlight 0 |
| queue.resume (WS) | cancelled, running, queued | 2 | |
| SIGKILL + restart | cancelled, cancelled, queued held | 2 | held 1 |
No resend, queue kept and held, no continuation effect.

## (b) hold / restart / resume: PASS  (10-16 05:33-05:35 PT)
| step | result | prompts |
|---|---|---|
| B turn 1 (no hold) | running | 3 |
| hold set (who/when/why returned) | held=true | 3 |
| WS message.dispatch steer_active on busy B | accepted, downgraded to queued B#2 | 3 |
| compat turn.start on idle C | accepted, run starting, start effect pending attempt 0, heldEffects 1 | 3 |
| graceful restart under hold | hold persisted; B#1 cancelled; B#2 queued held; C#1 unsent start requeued queued+held (not cancelled) | 3 |
| queue.resume C while still held | C starting, effect pending, nothing sent | 3 |
| hold clear | C delivered once | 4 |
| queue.resume B | B#2 (the steer text) delivered once | 5 |
Per-message delivery counts: each exactly 1. Hold history: set + clear rows with actor, reason, time.
Note: after a clear, threads whose queue is held (restart or recovery) still need queue.resume, as on stock 0.1.0.

## Identity note
A source run reports version 0.0.45 (upstream stamps versions only at release build) and bundleSha256 null (no .mjs).
The deploy build must run scripts/update-release-package-versions.ts so readbacks report 0.1.0 and a bundle sha.
