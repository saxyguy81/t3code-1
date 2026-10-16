# hanan-work#303: 0.1.0 deploy notes (D-20261016-02)

For the release and drain owners. Proofs (a)–(c) are in PROOFS.md. Proofs (d) rollback and (e) readbacks are yours.
The branch is not merge-ready yet: the Opus review blocker (a held steer can block Stop and approval answers on its
thread) and should-fix items 2–5 and 8 are being fixed. Do not deploy before that round lands.

## 1. Identity readbacks (e) need a release build
- A source run reports `runtime.version` from `apps/server/package.json`, which upstream leaves at `0.0.45`.
  Upstream stamps versions only in the release build (`scripts/update-release-package-versions.ts`).
- `runtime.bundleSha256` is computed only when the entry is a `.mjs` bundle (`dist/bin.mjs`). It is captured once at
  boot, so it describes the bytes the process loaded, not whatever is on disk later. Source runs report `null`.
- So: build with the version stamp (0.1.0) and bundle, record the bundle's sha256 at build time, and on every target
  check `GET /api/orchestration/inventory` (scope `orchestration:read`) returns that version and sha, `hold`, `counts`
  all 0 before the move, and `continueThreadsAfterServerUpdate.global = false` with `projectOverridesEnabled = []`.

## 2. continueThreadsAfterServerUpdate
- 0.0.45 defaulted it to false and never wrote it; 0.1.0 defaults to true.
- On first boot, 0.1.0 writes `false` only when the key is absent from settings.json and the database holds
  0.0.x threads (`projection_threads` rows).
- A target with no 0.0.x threads, or a fresh install, keeps 0.1.0's `true` unless you set it. Write
  `"continueThreadsAfterServerUpdate": false` explicitly on the hub and every env and app, then confirm it in the
  inventory readback.
- That first boot rewrites settings.json (strict JSON from the 0.1.0 schema): comments are lost and keys 0.1.0 doesn't
  know may be dropped. Copy `settings.json` to `settings.json.pre-0.1.bak` before the first 0.1.0 boot.
- Known issue being fixed (review item 8): a JSONC settings file with an explicit `true` is currently read as "absent"
  and flipped to false.

## 3. Drain and rollback
- The import carries transcripts only. v1 queued and in-flight turns are not carried over, so drain to EMPTY first
  (0.0.45 dispatch-freeze inventory 0).
- 0.1.0 copies `state.sqlite` to `statev2.sqlite` once and never writes `state.sqlite`. Migration 063 only adds tables.
  Rollback to 0.0.45 is therefore mechanically safe. But everything accepted on 0.1.0 is invisible after a rollback,
  including messages held under the hub hold. Before rolling back, clear the hold, drain 0.1.0 to inventory counts 0,
  and treat 0.1.0-era transcripts as lost to 0.0.45.

## 4. Operating the hub hold
- Set: `POST /api/orchestration/hub-hold/set {"reason": "..."}`. Clear: `POST /api/orchestration/hub-hold/clear`.
  Read: `GET /api/orchestration/hub-hold`.
  - Set and clear need scope `environment:maintain`. A local CLI token with that scope can always be issued with
    `t3 auth session issue --scope environment:maintain`.
  - The actor (principal and session), reason and time are recorded. History is in `orchestration_v2_hub_hold_history`.
- Messages are always accepted under the hold. Nothing new reaches a provider until the hold clears.
- After a restart that happened under the hold, every thread with work is queue-held. Clearing the hold does not resume
  those queues: send `queue.resume` per thread (v2 WS `orchestration.dispatchCommand`), the same as stock 0.1.0's own
  restart hold. The inventory's `counts.held` shows how many runs wait.
- There is no UI for the hold yet. Web users just see messages queue.

## 5. Self-update
- 0.1.0 has no setting to turn self-update off. The patch adds a fail-closed guard instead: the server update path
  and the desktop commit path refuse unless the inventory is readable and queued, in-flight, claimed and held counts
  are 0.
- Known gaps being fixed (review items 2, 3):
  - the desktop renderer's install button bypasses the server guard;
  - the guard is check-then-act.
- For boot-service hubs, the guard covers the server update path.

## 6. Provider instances: Cursor/ACP threads fail their first 0.1.0 turn
- 0.1.0's `cursor` driver uses the Cursor Agent SDK (it needs a Cursor sign-in or CURSOR_API_KEY), not the 0.0.45
  ACP agent binary. A 0.0.45 thread on a cursor/ACP instance fails its first 0.1.0 turn. The failure is visible as a
  failed run, and nothing is lost silently.
- Move such threads to a 0.1.0 instance (per turn via `modelSelection`; proven in PROOFS (c)).
- Only cursor was verified. Treat grok and opencode instances the same way until checked.
- **The list must come from a hub snapshot on the M2.** t2 has no `t3-state-read`, and `m2-state` rows carry no
  provider field. Run this against the 0.0.45 `state.sqlite` snapshot:

```sql
SELECT json_extract(model_selection_json, '$.instanceId') AS instance,
       COUNT(*) AS threads,
       SUM(archived_at IS NULL) AS unarchived,
       group_concat(substr(thread_id, 1, 8), ' ') AS thread_ids
FROM projection_threads
WHERE deleted_at IS NULL
GROUP BY 1
ORDER BY 2 DESC;
```

  Map each instance to its driver with the hub's settings.json `providerInstances` (a built-in instance id equals its
  driver kind, e.g. `cursor`, `codex`, `claudeAgent`). Every thread whose instance resolves to `cursor`, `grok` or
  `opencode` belongs on the list.

## 7. Router adoption
- The first turn of a migrated thread is a full-context send: the single user message carries the imported history.
- On the real t2 router it was one request, one turn_request, one attempt, dispatch ordinal 0, HTTP 200 and no 409
  (PROOFS (c) router half).
- Resume the lead first and then a few threads at a time. Rotate workers rather than migrate them (ruling).

## 8. Compat `POST /api/orchestration/dispatch`
- It accepts the 0.0.45 shapes for:
  - `thread.turn.start`, `thread.create`, `thread.turn.interrupt`, `thread.session.stop`;
  - `thread.archive`, `thread.unarchive`, `thread.settle`, `thread.meta.update`.
- Other types return 400.
- Being fixed before any operator tool relies on it (review items 4–7):
  - interrupt command ids are state-dependent on retry, and `turnId` is ignored;
  - `onlyIfSettled` is checked outside the thread lock;
  - errors are all mapped to 400;
  - `bootstrap` and `sourceProposedPlan` are dropped.
- Interrupt and stop currently hit every active run, including `waiting` ones and delegated child tasks.
- `thread.archive` cancels queued runs, including held ones.
