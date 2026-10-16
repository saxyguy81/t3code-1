# URGENT: independent Opus review of the T3 Code 0.1.0 hub patch set (hanan-work#303, D-20261016-02)

Priority: URGENT. Scott wants the 0.1.0 upgrade ASAP (the phone app cannot reach the 0.0.45 servers).
Reviewer: a fresh Opus thread on the OptiPlex or mbp2013 (t2 is busy). Read-only review; do not push.

## Get the code
```
git clone https://github.com/pingdotgg/t3code.git && cd t3code     # or any clone with tag v0.1.0
git checkout -b review-303 81493efb7                                # upstream v0.1.0
git fetch https://github.com/saxyguy81/t3code-1.git hub-hold-303-patches
git show FETCH_HEAD:hub-hold-303/README                             # apply instructions
git archive FETCH_HEAD hub-hold-303 | tar -x -C /tmp && git am /tmp/hub-hold-303/0*.patch
```
Review `git diff 81493efb7..HEAD`. The head should correspond to t2 commit 8c5e6f32e (9 commits).

## Scope (lead rulings)
1. continueThreadsAfterServerUpdate=false on import from 0.0.x, with a runtime readback.
2. One hub-wide durable accept-and-hold flag. API set/clear/read with who/when/why. Checked at message.dispatch, turn
   start and continuation. Queue, never refuse. Interrupts and approvals are never held.
3. A read-only inventory and identity endpoint: version, bundle sha, and counts of queued, in-flight, held and outbox.
4. Self-update: a fail-closed guard (0.1.0 has no off switch).
5. COMPAT `POST /api/orchestration/dispatch` with the 0.0.45 shape, over the v2 dispatch path and through the hold.

## Lens: DESTRUCTIVE
For every change, ask what it could destroy on a real hub.
- **Data:** DB and migration 063, the settings.json rewrite, secrets.
- **Sends:** irreversible or duplicate provider sends.
- **Message loss:** lost or duplicated queued messages across restart, crash, upgrade and rollback to 0.0.45.
- **Lockout:** a hold that cannot be cleared, or a server that fails to boot.
- **Self-update:** whether the guard can fail open.
- **Compat endpoint:** compat commands that stop, archive or interrupt more than 0.0.45 did.
- **Upgrade risk:** anything that makes the 0.0.45 → 0.1.0 upgrade itself riskier.

## Inputs
- `proofs/PROOFS.md`: proofs (a), (b), (c) and the router half, run on scratch hubs on t2. Say whether they show what
  they claim.
- `proofs/DEPLOY-NOTES.md`.
- `proofs/REVIEW-opus-1.md`: the first review, done on t2. Read it only AFTER forming your own findings, then say
  where you agree, disagree or found more. Its blocker: a held steer, restart or continue blocks Stop and approval
  answers on its thread, through the outbox per-thread FIFO.

## Output
Post on saxyguy81/hanan-work#303:
- findings ranked blocker / should-fix / nit, each with file:line and a failure scenario;
- a section on the destructive lens;
- a section on the proofs;
- an explicit answer: is this safe to deploy to the hub NOW as an emergency, with which mitigations, or not;
- a final line `VERDICT: GO|NO-GO (reviewed <head sha>)`.
End the comment with `<!-- agent -->`.
