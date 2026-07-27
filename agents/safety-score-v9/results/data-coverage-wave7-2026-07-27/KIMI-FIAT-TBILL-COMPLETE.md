# KIMI-FIAT-TBILL complete — 2026-07-27

The successor lane ran after `KIMI-MECH-COMPLETE.md` and remained the sole writer for the
mechanism overlay and mechanism-measurements surfaces.

## Result

- Re-landed D2 partial metrics for `apxusd-apyx`, `usdf-falcon`, and `rwausdi-multipli`;
  verified the existing `usd3-3jane` entry; corrected `onyc-onre` WAM to an honest
  `unavailable` state.
- Reviewed the 151 fiat-cash/tbill mechanism items across all 90 lane assets, supply ordered.
  Two components were admitted: `eutbl-spiko.durationAndLiquidity` and
  `ustbl-spiko.durationAndLiquidity`, both `adequate` under the dated 4 May 2026 UCITS
  prospectus. All other assets have a bounded `BLOCKED`/`DEFERRED` terminal in
  `ledger-kimi-fiat-tbill.md`.
- Regenerated the evaluation-build manifest:
  `070a9e3f8d52d6ade6625945f381468b2dcffb3ce39167c27891c930eb96bd0a`.

## Verification

- Focused mechanism triad: 21/21 tests passed.
- `npm run check:safety-score-v9-evaluation-build`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- Pinned-envelope replay and regenerated registry are recorded in the ledger. All four replay
  changes are attributed; no unexplained mover remains. Same-day review activation follows
  VER2-004, so the fixed 2026-07-27 capture conservatively waits for the next UTC day before
  newly reviewed D2/D3 facts become score-bearing.

No branch, PR, or push was made.
