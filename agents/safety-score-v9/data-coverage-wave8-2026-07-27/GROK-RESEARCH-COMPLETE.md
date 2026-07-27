# GROK-RESEARCH-COMPLETE

Lane terminal for wave-8 GROK-RESEARCH (2026-07-28 night shift).

## Per-stream counts (registry items)

### Stream A — reserve (133)
- WRITTEN: **98**
- SINGLE_SOURCE_LEDGER_ONLY: **13**
- BLOCKED(honest): **12**
- SKIP(already-current): **6**
- QUARANTINED(REFUTED): **4**

### Stream B — controls (105)
- BLOCKED(honest): **65**
- WRITTEN: **25**
- SKIP(already-current): **10**
- QUARANTINED(REFUTED): **5**

### Stream C — mech (68)
- WRITTEN: **48**
- BLOCKED(honest): **17**
- QUARANTINED(REFUTED): **3**

### Grand (306)
- WRITTEN: **171**
- BLOCKED(honest): **94**
- SKIP(already-current): **16**
- SINGLE_SOURCE_LEDGER_ONLY: **13**
- QUARANTINED(REFUTED): **12**

## Phase-2 refutation rate

Among independent write verifications with REPRODUCED or REFUTED verdicts:

- REPRODUCED: **155**
- REFUTED: **7**
- Refutation rate: **4.3%**

REFUTED assets received **full file reverts** (never partial repair): cusd-cap packet deleted; mxne-real-mxn, iusd-indigo-protocol, usdv-solomon, sdusd-dtrinity control schema failure, and disposition/ku mismatches.

## Least-confident items (flagging is credit)

- **usdt-tether** 28× bridge-supply unmatched controls — no dual-sourceable on-chain controller for DefiLlama unmatched keys
- **cusd-cap** mech packet REFUTED for empty required rwa metrics
- **Quarantines after verification/gate**: mxne-real-mxn, iusd-indigo-protocol, usdv-solomon, sdusd-dtrinity
- **Single-source ledger-only reserves** (13), including opaque issuers (gbpe-monerium, eurot-token-teknoloji, etc.)
- **Live-price algorithmic metrics** (fpi-frax, fusd-freedom-dollar) — method pinned; absolute floats drift with price

## Gates

- `npm run check:stablecoin-data`: only stale `coins.generated.json` (MAP forbids overnight regeneration)
- Focused `loadPerCoinStablecoinEntries()` after quarantine reverts: **FOCUSED_GATE_OK**
- Mechanism packets: **39**, all `verification.verdict: REPRODUCED`

## Surfaces / hard boundaries

- Wrote only cohort coin JSON + `domains/reserves|mint-authority|risk-review/**` + `mech-packets/`
- Untouched: `mechanism-review-overlays-v1.json`, adverse-pinned assets, docs, generated artifacts
- No pushes; no score/counter claims (replay sealed)

## Deliverables

- Stream markers `GROK-STREAM-A|B|C-COMPLETE.md`
- `ledger-grok-research.md` (306 rows)
- This complete file
- Force-added copies under `agents/safety-score-v9/results/data-coverage-wave8-2026-07-27/` for git (parent `/agents/` is gitignored)
