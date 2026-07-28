# KIMI-MECH-2-COMPLETE

Lane: KIMI-MECH-2 — mechanism overlay drain, rotation 2 (2026-07-27 night shift)
Status: **complete**

## Tally

- Queue 1 (33 RESEARCH-NEEDED): APPLIED 22, BLOCKED(issuer-undisclosed) 1 (xai-silo-finance,
  lifecycle ruling for coordinator), SKIP(already-current) 10.
- Queue 2 (38 Grok packets): APPLIED 20, REJECTED(packet-unverified) 1 (ftusd-flying-tulip —
  false unavailable rationale), REJECTED superseded-by-draft 17 (overlaps; discrepancies
  itemized in ledger).
- Overlay: 304 → 327 entries, all landed reviewedAt 2026-07-27, schema-valid, no duplicate
  assetIds. 42 journal sets under `mechanism-measurements/`.

## Gates (all green; sealed replay — no mover claims)

- MechanismReviewOverlaySchema validation per entry (tsx, pre-application).
- Focused vitest after every ~10 entries and at terminal: extension-mechanism 15 +
  archetype-profiles 5 = 20/20.
- fact-set 61 + manifest 11 + veritas-ver-010 identity 1 = 73/73.
- Journal producer suites (measure-cdp, measure-protocol-api) 48/48.
- eslint clean on changed TS; `git diff --check` clean.
- Evaluation-build manifest regenerated: `5eb13675f4ecf73304d858f16d18c9fb1fb989fb6f508db46cb18bf697e886aa`.

No score/counter/mover claims: offline replay is sealed (registry re-key); the morning
coordinator attributes movers at the first post-deploy capture.

Ledger: `ledger-kimi-mech2.md`. Drafts/verdicts/pipeline: `mech2-drafts/`, `mech2-apply/`.
One terminal commit: overlay file, measurements dir, manifest, archetype-profiles test, ledger, marker.
