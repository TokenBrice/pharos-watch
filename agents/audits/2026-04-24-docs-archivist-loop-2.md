# Documentation Archivist Loop 2

Date: 2026-04-24

Scope: deeper verification of public-doc publication mechanics, `docs/superpowers/**`, route/runbook docs that were lightly covered in loop 1, and stale hard-coded examples after the first correction push.

## Verification Coverage

- Dirac (`019dbf3e-6a19-7250-8928-6cfaa1d0ecc4`): public docs publication mechanics and generated export path.
- Averroes (`019dbf3e-6a4e-70f0-b803-c26387a652e2`): `docs/superpowers/**`; the model was at capacity, so this scope was covered locally.
- Euler (`019dbf3e-6a84-7420-a1f8-bd2f9823aec2`): less-covered route and runbook docs.

## Corrections Applied

- Updated blacklist methodology examples in `docs/api-reference.md` and `docs/blacklist-tracker.md` from current v3.98 to the code-defined current v3.99.
- Moved current plan/spec artifacts from `docs/superpowers/**` to `/agents/plans/` and `/agents/specs/` so `/docs/` remains the verified documentation corpus.
- Replaced stale status-dashboard wording that called 186 the current active set; the rule now explains that missing-price status remains ratio-based as the active registry grows.
- Corrected Compare URL docs: `coins` accepts canonical IDs only, drops legacy IDs/raw symbols, and normalizes the URL on initial load.
- Corrected the blacklist-sync runbook to match current recommended actions for amount gaps: balance backfill, debug sync state, targeted remediation; pointer reset is reserved for unhealthy `sync-blacklist` or confirmed stuck cursors.
- Corrected the stablecoins-cache runbook to acknowledge the current recommended `backfill-cg-prices` action while clarifying that direct cache republish still comes from the next healthy `sync-stablecoins` run.
- Corrected endpoint-probe docs from full `Promise.all` fanout to the bounded 6-worker browser probing model.
- Added `NauticalChart` and its `useStablecoins()`/`peggedAssets` dependency to the chains route contract.

## Rejected Or Non-Commit Findings

- Dirac found stale `out/docs/api-reference/*` generated artifacts after the v3.99 source edit. `out/` is ignored and untracked; the validation build regenerates those artifacts locally, and production rebuilds them from source.

## Loop 3 Focus

- Verify the loop-2 corrections after commit/push.
- Sweep for stale hard-coded versions/counts and route docs not edited in loop 2.
- Stop if the next verification phase returns fewer than 3 actionable documentation errors.
