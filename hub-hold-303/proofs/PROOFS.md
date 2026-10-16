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

## (c) import of copied 0.0.45 state: PASS  (10-16 05:36-05:45 PT)
Source: a scratch 0.0.45 hub (separate worktree at the live line's commit 639d1813c, scratch install, scratch home),
never live state. Built with the same 0.0.x `POST /api/orchestration/dispatch` bodies the compat endpoint takes
(so they are confirmed against real 0.0.45): project.create, 2 threads, 4 completed turns (ACP mock via a cursor
binaryPath wrapper), one thread.meta.update rename. 0.0.45 settings.json had no continueThreadsAfterServerUpdate key.
Copied the home (state.sqlite sha256 prefix 85de8efb7b5c3d17, unchanged after the run) and booted 0.1.0 on the copy:
- settings.json now holds `continueThreadsAfterServerUpdate: false`; inventory readback `global: false`, no project overrides.
- Both threads imported with titles (rename kept); both transcripts serve all user turns and assistant replies.
- Inventory after import: all counts 0 (the v1 queue was empty; the import carries no v1 queued or in-flight turns).
- First turn after import, sent through compat with modelSelection on an ACP mock instance: completed, one prompt,
  and that prompt carried the prior turns' text (full-context handoff), delivered once.
- Harness note: 0.1.0's cursor driver uses the Cursor Agent SDK, so a 0.0.45 cursor/ACP instance fails its first
  turn on 0.1.0 with a visible failed run (not a silent loss). Threads must move to a 0.1.0 provider instance.

## (c) router half: first post-import turn through the REAL t2 router: PASS  (10-16 05:49 PT)
Fresh 0.1.0 import of the same 0.0.45 copy (home-c02). Claude instance (`claudeAgent`, the local claude CLI, scratch
CLAUDE home, the t2 credential helper by path, consumer t3-t2) pointed at a loopback pass-through (`router-tap.mjs`) in
front of the t2 router 127.0.0.1:18788; the tap records method/path/model/status/id headers only.
First turn on imported thread pc-thread-1 via compat `thread.turn.start` (modelSelection claude / claude-sonnet-5-5),
one small prompt ("Reply with exactly the word OK."):
- T3 run completed; assistant reply "OK". The single user message the CLI sent carried both imported turns and their
  replies plus the new prompt (full-context handoff).
- The turn's request (from the CLI session log `requestId`): `req_011Cg5whckLTMkTwQxTihxR2`,
  router `x-request-id 9776d140`, conversation `conv_efd750a5f19244eeb5cb25ae373650e1`, HTTP **200**.
- Router replica (as_of 05:52:03 PT): that conversation has **1** turn_request (`request_94e4a425f0c5414e8afd05eb06fbc982`),
  state succeeded, commit visible_output, **1** attempt, dispatch_ordinal 0, 0 attempt_failures. No 409 anywhere in the tap.
- The tap also saw one CLI-internal side call (`req_011Cg5whZuvSA8XrFpacuahx`, conv_e5402332…, 200, 1 attempt; not part
  of the session transcript) and two `HEAD /api/hello` 404 probes from the CLI.
