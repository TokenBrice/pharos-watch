# KIMI-AUDIT-COMPLETE — wave-8 cross-vendor audit (2026-07-28)

Lane terminal for the KIMI-AUDIT containment layer. Full coverage, not sampled.

## Headline numbers

- **Assets audited: 146 asset-streams** (Stream A: 100 reserve assets; Stream B: 8
  controls assets; Stream C: 38 mech packets). GROK's four self-quarantines
  (mxne, iusd-indigo, usdv, sdusd) verified byte-clean against the pre-GROK
  baseline `e958a3db1` — nothing landed, nothing to audit.
- **Claims checked: 849** → 830 REPRODUCED / 15 REFUTED / 4 UNVERIFIABLE.
  **Claim reproduction rate: 97.6%.**
- **Quarantines: 2 data files reverted** (full-file, to `e958a3db1`):
  `cgo-comtech` reserves sidecar (segregation downgrade contradicted by its own
  cited source) and `gldt-gold-dao` coin JSON (false citation underpinning a
  freshness bump; substance corroborated — re-land with honest citation).
- **Mech packets REJECTED: 5** (`cdxusd-cod3x`, `fpi-frax`, `ftusd-flying-tulip`,
  `iauon-ondo`, `nwisdom-nest`) — `.REJECTED` markers written. Dominant failure
  mode: D3 grade-basis overreach (adequate/limited graded on issuer-docs or blog
  narrative without the required external anchor), plus one numeric mismatch
  (nWISDOM "T+1" vs source's 4 days).

## Auditor fallibility

Three swarm REFUTED verdicts (Nest-cluster packets nOPAL/nBASIS/nALPHA) were
themselves false positives: the auditors hit a stale copy of the Nest
available-vaults page. Coordinator re-check (two independent fetches, snapshot
2026-07-27 17:20Z) confirms T+1 as the packets claim — verdicts overturned to
REPRODUCED. Cross-vendor audit is not infallible either; evidence is in the ledger.

## Cross-check vs KIMI-MECH-2

No CROSS-CHECK-FAILED: the overlay was untouched when the REJECTED markers landed.
KIMI-MECH-2 drafts existed for 3 of the 5 refuted packets; markers precede its
terminal commit. Morning coordinator: confirm its terminal commit contains no
entry for the five refuted assets.

## Gates

Reverted files: JSON-valid, `git diff --check` clean (byte-identical to a state
that passed gates pre-wave). No score/counter claims (replay sealed). No pushes.

Deliverables: `ledger-kimi-audit.md` (146-row verdict table, quarantine evidence,
poll history), 5 `.REJECTED` markers, this file. Committed last, explicit paths.
