# Redemption Backstop Top-100 Investigation

Date: 2026-03-24

## Scope

- Market-cap ranking from live `GET https://api.pharos.watch/api/stablecoins`
  - snapshot timestamp: `2026-03-23T23:15:19Z`
- Redemption snapshot from live `GET https://api.pharos.watch/api/redemption-backstops`
  - snapshot timestamp: `2026-03-23T23:13:16Z`
- Confidence logic reviewed in:
  - `docs/redemption-backstops.md`
  - `shared/lib/redemption-backstop-confidence.ts`
  - `worker/src/lib/redemption-backstop-sources.ts`
  - `shared/lib/redemption-backstop-configs/*`
- Existing internal research reused where relevant:
  - `agents/redemption-backstop-top50-investigation-2026-03-23.md`
  - `agents/2026-03-22-redemption-backstop-audit.md`
  - `agents/research/real-time-reserve-update-sources.md`
  - `agents/research/2026-03-14-crypto-backed-reserve-sources.md`

## Executive Read

The top end is already in much better shape than the module-wide long tail.

- Top 50 today: `37 medium`, `4 high`, `2 low`, `7 missing`
- Top 100 today: `67 medium`, `6 high`, `9 low`, `18 missing`
- Top-100 market cap still below medium: about `$4.395B`
  - `low`: `$1.880B`
  - `missing`: `$2.515B`

That is a large shift from the 2026-03-23 note because many of the big docs/config lifts have already landed.

The remaining work is no longer mostly "review docs and mark documented-bound." It is now mostly:

1. telemetry / adapter work for dynamic capacity
2. asset curation for unconfigured live-feed IDs
3. a small number of placeholder-ratio cleanups

## Current Constraint

Under the current confidence model:

- `low` if unresolved
- `low` if capacity confidence is still `heuristic`
- `medium` if resolved and capacity is `documented-bound` or `dynamic`
- `high` only if resolved, capacity is `dynamic`, and fee confidence is not `undisclosed-reviewed`

Source:

- `shared/lib/redemption-backstop-confidence.ts`
- `worker/src/lib/redemption-backstop-sources.ts`

Practical implication:

- Most big offchain issuers are already `medium`.
- They will not become `high` without real dynamic capacity telemetry.
- Better docs alone will not move them further.

## Effort Rubric

- `1` = config/docs-only tweak using current model
- `2` = reclassification or bounded-model cleanup using existing primitives
- `3` = new reserve/redemption telemetry or moderate adapter work
- `4` = substantial new adapter/canonicalization/modeling work
- `5` = likely not worth near-term spend, or probably should stay outside coverage

Priority ranking below uses `market cap / effort`.

## Ranked Priority List

This list mixes:

- `low`/`missing` assets that can realistically get to `medium`
- `medium` assets where a credible path to `high` exists

### Tier 1: Best Near-Term ROI

| Priority | Asset | MCap | Current | Target | Effort | Why it matters | What would move it |
| --- | --- | ---: | --- | --- | ---: | --- | --- |
| 1 | `USDD` | `$1.173B` | low | high | 3 | Biggest remaining low-confidence top-100 name | Replace the heuristic `16%` PSM ratio with live USDD reserve / PSM telemetry; research note already flags TRON + EVM aggregation as the blocker |
| 2 | `USDe` | `$5.916B` | medium | high | 3 | Largest credible medium -> high candidate | Capacity is already dynamic; the blocker is fee confidence. Add live redeem-fee / execution-cost telemetry or revise the fee-confidence model for documented variable-cost rails |
| 3 | `wsrUSD` | `$0.096B` | medium | high | 2 | Cheap high-confidence win | Capacity is already dynamic via reserve-sync metadata; needs a stronger fee-confidence source than `undisclosed-reviewed` |
| 4 | `DOLA` | `$0.182B` | medium | high | 3 | Existing docs are already strong; live data is the missing piece | Replace the documented `8%` PSM share bound with live transparency / onchain PSM telemetry |
| 5 | `reUSD` | `$0.183B` | low | medium | 3 | One of the larger remaining low-confidence names | Replace the heuristic `20%` queue ratio with a reviewed bound or live buffer telemetry from the protocol's transparency stack |
| 6 | `USDX` (`id=214`) | `$0.683B` | missing | medium | 4 | Large market cap, but currently outside canonical route coverage | Canonicalize the asset into the tracked registry, verify whether it has a real primary redemption rail, then add a proper config |
| 7 | `USDF` (`Astherus`) | `$0.125B` | low | medium | 4 | Explicit placeholder ratio still in config | Current route is a generic `15%` placeholder. Needs protocol-specific liquid-buffer evidence or telemetry before it should graduate |
| 8 | `DUSD` (`StandX`) | `$0.100B` | low | medium | 3 | Placeholder heuristic in an issuer-style rail | Replace the `15%` placeholder with reviewed issuer/settlement evidence or live liquid-buffer telemetry |
| 9 | `FPI` | `$0.097B` | low | medium | 2 | Cleaner than the remaining strategy-backed names | Review Frax's CPI redemption mechanics and decide whether full-supply eventual redemption should be `documented-bound`; if yes, this is mostly a config promotion |
| 10 | `LISUSD` | `$0.076B` | low | medium | 3 | Existing docs already disclose a redeem fee and daily limit | The missing step is a better capacity model than the current heuristic ratio, likely an absolute-cap / daily-limit-aware bound or live BNB-chain adapter work |

### Tier 2: Good Follow-Ups After Tier 1

| Priority | Asset | MCap | Current | Target | Effort | What would move it |
| --- | --- | ---: | --- | --- | ---: | --- |
| 11 | `USR` | `$0.046B` | low | medium | 4 | Scrape Apostro/Resolv transparency JSON or add a protocol adapter for the liquid-cash bucket; offchain hedge semantics make `high` hard |
| 12 | `MSUSD` | `$0.042B` | low | medium | 3 | Add reviewed direct-redemption evidence or live reserve/buffer telemetry; current route is still generic supply-full heuristic |
| 13 | `YUSD` | `$0.038B` | low | medium | 3 | Reuse the existing Accountable reserve source to publish redemption-relevant buffer metadata instead of only reserve composition |
| 14 | `JUPUSD` | `$0.077B` | medium | high | 3 | The route already has a documented-bound `10%` USDC buffer; a live buffer feed is the clear next lift |
| 15 | `ZCHF` | `$0.037B` | missing | medium | 4 | Decide reserve semantics first, then use the Frankencoin indexing stack to model collateral-backed redemption properly |
| 16 | `MIM` | `$0.031B` | missing | medium | 4 | Multi-cauldron onchain adapter plus route config |
| 17 | `sUSD` | `$0.040B` | missing | medium | 4 | Synthetix V3 vault/pool/market accounting first, then decide whether a credible holder redemption rail exists in current protocol reality |

## Do Not Prioritize Near-Term

These names are either likely poor candidates, cemetery/curation work first, or do not obviously have a credible direct backstop worth modeling right now.

| Asset | MCap | Current | Recommendation |
| --- | ---: | --- | --- |
| `crvUSD` | `$0.247B` | missing | Defer. Live-collateral adapters are plausible for reserves, but a holder redemption backstop comparable to current route families is still not clearly established |
| `FRAX` | `$0.210B` | missing | Defer. Prior repo research already treated canonical FRAX as non-redeemable for this module |
| `BUSD` (`id=153`) | `$0.233B` | missing | Cemetery/legacy path first, not redemption-confidence work |
| `HUSD` (`id=17`) | `$0.192B` | missing | Cemetery/legacy path first |
| `FLEXUSD` (`id=21`) | `$0.166B` | missing | Cemetery/legacy path first |
| `MUST` (`id=328`) | `$0.154B` | missing | Curation first |
| `BUSD` (`id=4`) | `$0.040B` | missing | Legacy duplicate; do not spend redemption time before asset cleanup |
| `BEAN` | `$0.033B` | missing | Low cap and route semantics unlikely to justify near-term spend |
| `USDN` | `$0.030B` | missing | Legacy / distressed profile; low ROI |

## Main Takeaways

### 1. The top end is no longer a docs problem

The previous "review docs and upgrade to documented-bound" wave has mostly already happened for the largest names.

What is left at scale:

- `USDD` adapter work
- fee-confidence work for `USDe`
- dynamic-capacity work for a small set of `medium -> high` candidates
- curation of live-feed IDs that are not in the canonical route registry

### 2. The current model makes `high` structurally rare

Today, `high` effectively means:

- dynamic capacity
- non-opaque fee model

That is appropriate for rigor, but it means most offchain issuer routes will plateau at `medium` unless Pharos starts ingesting issuer-specific primary-liquidity telemetry.

### 3. The remaining low-confidence backlog is concentrated in placeholder ratios

The cleanest backlog items are the coins that still have explicit placeholder notes or generic ratio proxies:

- `usdd-tron-dao-reserve`
- `reusd-re-protocol`
- `usdf-astherus`
- `dusd-standx`
- `usr-resolv`
- `yusd-aegis`
- `lisusd-lista`

That is where engineering time will most directly reduce low-confidence coverage.

## Recommended Execution Order

1. `USDD`
   - highest market-cap low-confidence gap
   - clearest single-name telemetry win
2. `USDe` and `wsrUSD`
   - cheapest path to additional `high` coverage
   - mostly fee-confidence / telemetry work, not broad re-modeling
3. `DOLA`, `reUSD`, `LISUSD`
   - strong candidate set for replacing heuristic/documented bounds with better runtime evidence
4. `USDX (214)` and other large missing live-feed IDs
   - only after deciding whether they belong in the canonical tracked registry or the cemetery/legacy path
5. Placeholder strategy-backed names
   - `USDF`, `DUSD`, `USR`, `YUSD`, `MSUSD`

## Appendix: Top-100 Sub-Medium Names

As of the live snapshot, these top-100 assets remain below medium confidence:

- `USDD` `$1.173B` `low`
- `USDX` (`id=214`) `$0.683B` `missing`
- `crvUSD` `$0.247B` `missing`
- `BUSD` (`id=153`) `$0.233B` `missing`
- `FRAX` `$0.210B` `missing`
- `HUSD` (`id=17`) `$0.192B` `missing`
- `reUSD` `$0.183B` `low`
- `FLEXUSD` (`id=21`) `$0.166B` `missing`
- `MUST` (`id=328`) `$0.154B` `missing`
- `USDF` (`Astherus`) `$0.125B` `low`
- `DUSD` (`StandX`) `$0.100B` `low`
- `pmUSD` `$0.100B` `missing`
- `USPD` `$0.099B` `missing`
- `FPI` `$0.097B` `low`
- `DEUSD` `$0.092B` `missing`
- `LISUSD` `$0.076B` `low`
- `USP` `$0.065B` `missing`
- `USDM` (`MegaUSD`) `$0.062B` `missing`
- `USR` `$0.046B` `low`
- `MSUSD` `$0.042B` `low`
- `BUSD` (`id=4`) `$0.040B` `missing`
- `sUSD` `$0.040B` `missing`
- `YUSD` `$0.038B` `low`
- `ZCHF` `$0.037B` `missing`
- `BEAN` `$0.033B` `missing`
- `MIM` `$0.031B` `missing`
- `USDN` `$0.030B` `missing`
