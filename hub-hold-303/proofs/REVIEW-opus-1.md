# Opus review 1 of feat/hub-hold-303 (81493efb7..8c5e6f32e), with the destructive lens. 10-16 ~05:50 PT

Verdict: do not merge yet. Fix items 1-5 and 8 first, then add proofs for:
- Stop and approval answers under the hold
- SIGKILL under the hold
- selfUpdate refusal
- compat interrupt/stop retries
- a JSONC settings import

## Blocker
1. A held steer, restart or continue blocks Stop and approval answers on its thread (`EffectOutbox.ts` claim predicate).
   - Cause: per-thread FIFO counts held pending rows as earlier work.
   - Promote-to-steer bypasses the dispatch downgrade.
   - Thread stop doesn't cancel pending steers.

## Should-fix
2. The desktop renderer install IPC bypasses `requireQuiescentHub`.
3. The guard is check-then-act. It also doesn't count pending interrupt and respond effects.
4. Compat interrupt command ids depend on current state, so a retry can skip a run. `turnId` is ignored.
5. Compat `onlyIfSettled` runs outside the thread lock and differs from the 0.0.45 predicate.
6. Compat maps every error to 400 after partial commits. The principal isn't recorded.
7. Compat drops `bootstrap`, `sourceProposedPlan` and upload attachments. Mode decode defaults can reset modes.
8. `hasStoredContinuationKey` uses strict JSON while settings load as JSONC. An explicit `true` gets flipped.
9. Clearing the hold doesn't resume restart-held queues, and nothing tells the operator.
10. Fork migration id 63 can collide with upstream.

## Nits
- There is a small window between `releaseHeldClaim` and `execute`.
- A repeated `set` overwrites the first actor on the current row.
- `heldEffects` counts even when no hold is set.
- Title generation still sends message text under the hold.

## Destructive lens
- 063 only adds tables.
- Rollback is mechanically safe, but 0.1.0-era messages (held ones included) are invisible after it.
- The settings.json rewrite loses comments and maybe unknown keys. Back the file up first.
- No lockout: the scope can always be issued locally.
- The guard fails closed; its gaps are items 2 and 3.
- Compat interrupt and stop hit `waiting` runs and delegated children. Archive cancels held queued runs.

## Proof gaps noted
- Proof (a) is stock restart behaviour.
- Not exercised:
  - Stop or approval under the hold
  - SIGKILL under the hold
  - the claim race
  - the selfUpdate guard
  - compat interrupt, stop, archive, settle and retries
  - scope rejection
  - a JSONC or explicit-true settings import
  - a completed turn followed by a queued start
- The identity readback is unproven until a stamped build is used.
