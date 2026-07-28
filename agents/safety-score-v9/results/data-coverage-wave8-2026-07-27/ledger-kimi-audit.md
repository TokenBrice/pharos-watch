# KIMI-AUDIT ledger — wave-8 (2026-07-27 night shift)

Cross-vendor adversarial verification of GROK-RESEARCH landings. Verdicts per claim:
`REPRODUCED` / `REFUTED(evidence)` / `UNVERIFIABLE(source-unreachable)`.
Default to REFUTED on ambiguity. Quarantine = full-file revert to pre-GROK committed
state, never a partial repair. UNVERIFIABLE alone does not quarantine.

Baseline: pre-GROK commit `e958a3db1`. GROK stream commits audited: `3bc2cebf9` (A,
103 data files), `cc63afe4c` (B, 8 coin JSONs), `cfaee4692` (C, 39 packets, usdv
self-quarantined by GROK before audit). GROK self-quarantines (mxne-real-mxn,
iusd-indigo-protocol, usdv-solomon, sdusd-dtrinity) verified byte-clean against the
baseline — excluded from audit, nothing landed to verify.
Stream commits touched only their declared surfaces (coins/, domains/reserves/,
mech-packets/, markers) — no surface violations found.

Method: 34-agent cross-vendor swarm (full coverage, not sampled), independent
sources/RPCs preferred over GROK's citations (eth.drpc.org, 1rpc.io, eth.llamarpc.com
vs GROK's publicnode/Blockscout where cited). Three auditor REFUTED verdicts were
themselves refuted on coordinator re-check (two independent fetches of the primary
source) and are recorded as REPRODUCED with the false-positive note — the burden of
proof cuts both ways.

Totals: **146 asset-stream verdicts** (100 A / 8 B / 38 C) over **849 claims**:
830 REPRODUCED / 15 REFUTED / 4 UNVERIFIABLE. Claim reproduction rate **97.6%**.
Asset-level: 138 REPRODUCED, 7 REFUTED, 1 MIXED (unverifiable-only).

## Per-asset verdicts

| Asset | Stream | Checked | Reproduced | Refuted | Unverifiable | Verdict |
|---|---|---|---|---|---|---|
| `a7a5-old-vector` | A | 8 | 8 | 0 | 0 | REPRODUCED |
| `aa-falconx-mev-capital` | A | 7 | 7 | 0 | 0 | REPRODUCED |
| `acrdx-anemoy-apollo` | A | 6 | 4 | 0 | 2 | MIXED |
| `aid-gaib` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `alusd-alchemix` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `apxusd-apyx` | A | 9 | 9 | 0 | 0 | REPRODUCED |
| `asusdf-astherus` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `audf-forte` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `audx-aussie-dollar-token` | A | 10 | 10 | 0 | 0 | REPRODUCED |
| `avusd-avant` | A | 9 | 9 | 0 | 0 | REPRODUCED |
| `axcnh-anchorx` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `aznd-mu-digital` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `bnusd-balanced` | A | 12 | 12 | 0 | 0 | REPRODUCED |
| `brl1-brl1` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `brlv-crown` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `brz-transfero` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `cash-phantom` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `cgo-comtech` | A | 7 | 6 | 1 | 0 | REFUTED |
| `cgusd-cygnus-finance` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `chfau-allunity` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `dgld-gold-token-sa` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `djed-coti` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `dola-inverse-finance` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `dusd-dtrinity` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `dusd-standx` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `eurau-allunity` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `eure-monerium` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `euri-banking-circle` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `euro3-3a-dao` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `eusd-telcoin` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `fusd-finchain` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `fusd-freedom-dollar` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `fxd-fathom` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `gldt-gold-dao` | A | 4 | 2 | 1 | 1 | REFUTED |
| `gusd-gate` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `hbusdt-hyperbeat` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `hlscope-hamilton-lane` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `hollar-hydrated` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `iauon-ondo` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `idrt-rupiah-token` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `idrx-idrx` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `iusd-initia` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `jpyc-jpyc` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `jpyt-dephaser` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `luausd-lumi-finance` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `mglobal-midas-fasanara` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `money-defi-money` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `moveusd-cfx` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `msusd-metronome` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `myrc-blox` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `nopal-nest` | A | 9 | 9 | 0 | 0 | REPRODUCED |
| `pathusd-bridge` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `pgold-pleasing` | A | 7 | 7 | 0 | 0 | REPRODUCED |
| `qcad-stablecorp` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `rwausdi-multipli` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `satusd-river` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `sbc-brale` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `scusd-rings` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `silk-shade-protocol` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `slvon-ondo` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `srusd-reservoir` | A | 8 | 8 | 0 | 0 | REPRODUCED |
| `stusd-stoneyield` | A | 2 | 2 | 0 | 0 | REPRODUCED |
| `susd-solayer` | A | 2 | 2 | 0 | 0 | REPRODUCED |
| `susd1plus-lorenzo` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `thbill-theo` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `tusd-trueusd` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `usda-alpha-partner` | A | 7 | 7 | 0 | 0 | REPRODUCED |
| `usda-anzens` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `usda-avalon` | A | 9 | 9 | 0 | 0 | REPRODUCED |
| `usdf-astherus` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `usdh-hermetica` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `usdkg-gold-dollar` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `usdm-mega` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `usdm-monetrix` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `usdon-ondo` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `usdr-ring` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `usdsui-sui` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `usdx-hex-trust` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `usdx-kava` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `usg-tangent` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `usn-noon` | A | 8 | 8 | 0 | 0 | REPRODUCED |
| `usp-pikudao` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `usx-solstice` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `uusd-anything-labs` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `vchf-vnx` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `vnxau-vnx` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `vusd-virtue` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `wars-argentine-peso` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `wbrl-ripio` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `wcop-ripio` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `weusd-picwe` | A | 4 | 4 | 0 | 0 | REPRODUCED |
| `witry-brix` | A | 6 | 6 | 0 | 0 | REPRODUCED |
| `wmxn-ripio` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `xai-silo-finance` | A | 10 | 10 | 0 | 0 | REPRODUCED |
| `xnk-kinka` | A | 7 | 7 | 0 | 0 | REPRODUCED |
| `xsgd-straitsx` | A | 5 | 5 | 0 | 0 | REPRODUCED |
| `yzusd-yuzu` | A | 17 | 17 | 0 | 0 | REPRODUCED |
| `zarp-zarp` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `zeusd-zoth` | A | 8 | 8 | 0 | 0 | REPRODUCED |
| `zys-zephyr-protocol` | A | 3 | 3 | 0 | 0 | REPRODUCED |
| `btcusd-btcfi` | B | 19 | 19 | 0 | 0 | REPRODUCED |
| `dai-makerdao` | B | 13 | 13 | 0 | 0 | REPRODUCED |
| `mai-qidao` | B | 4 | 4 | 0 | 0 | REPRODUCED |
| `usdh-hubble` | B | 7 | 7 | 0 | 0 | REPRODUCED |
| `usdm-moneta` | B | 3 | 3 | 0 | 0 | REPRODUCED |
| `usdp-paxos` | B | 5 | 5 | 0 | 0 | REPRODUCED |
| `xtusd-xt` | B | 9 | 9 | 0 | 0 | REPRODUCED |
| `yusd-yieldfi` | B | 6 | 5 | 1 | 0 | REPRODUCED |
| `alusd-alchemix` | C | 8 | 8 | 0 | 0 | REPRODUCED |
| `apyusd-apyx` | C | 10 | 10 | 0 | 0 | REPRODUCED |
| `asusdf-astherus` | C | 6 | 6 | 0 | 0 | REPRODUCED |
| `btcusd-btcfi` | C | 4 | 4 | 0 | 0 | REPRODUCED |
| `cdxusd-cod3x` | C | 3 | 2 | 1 | 0 | REFUTED |
| `dusd-standx` | C | 3 | 3 | 0 | 0 | REPRODUCED |
| `fpi-frax` | C | 6 | 5 | 1 | 0 | REFUTED |
| `ftusd-flying-tulip` | C | 5 | 3 | 2 | 0 | REFUTED |
| `fusd-freedom-dollar` | C | 6 | 6 | 0 | 0 | REPRODUCED |
| `iauon-ondo` | C | 9 | 2 | 7 | 0 | REFUTED |
| `inalpha-nest` | C | 6 | 6 | 0 | 0 | REPRODUCED — auditor false positive overturned (T+1 confirmed in source, 2 independent fetches) |
| `jpyt-dephaser` | C | 5 | 5 | 0 | 0 | REPRODUCED |
| `mapollo-midas` | C | 3 | 3 | 0 | 0 | REPRODUCED |
| `mf-one-midas` | C | 9 | 9 | 0 | 0 | REPRODUCED |
| `mhyper-midas` | C | 10 | 10 | 0 | 0 | REPRODUCED |
| `mmev-midas` | C | 3 | 3 | 0 | 0 | REPRODUCED |
| `mre7yield-midas` | C | 3 | 3 | 0 | 0 | REPRODUCED |
| `nbasis-nest` | C | 7 | 7 | 0 | 0 | REPRODUCED — auditor false positive overturned (T+1 confirmed in source, 2 independent fetches) |
| `nopal-nest` | C | 8 | 8 | 0 | 0 | REPRODUCED — auditor false positive overturned (T+1 confirmed in source, 2 independent fetches) |
| `nusd-neutrl` | C | 8 | 8 | 0 | 0 | REPRODUCED |
| `nwisdom-nest` | C | 7 | 6 | 1 | 0 | REFUTED |
| `reusd-re-protocol` | C | 12 | 12 | 0 | 0 | REPRODUCED |
| `reusd-resupply` | C | 8 | 8 | 0 | 0 | REPRODUCED |
| `rusd-reservoir` | C | 7 | 7 | 0 | 0 | REPRODUCED |
| `said-gaib` | C | 6 | 6 | 0 | 0 | REPRODUCED |
| `sbold-k3-capital` | C | 5 | 5 | 0 | 0 | REPRODUCED |
| `srusd-reservoir` | C | 6 | 6 | 0 | 0 | REPRODUCED |
| `stcusd-cap` | C | 7 | 7 | 0 | 0 | REPRODUCED |
| `susd1plus-lorenzo` | C | 6 | 6 | 0 | 0 | REPRODUCED |
| `susn-noon` | C | 9 | 9 | 0 | 0 | REPRODUCED |
| `syusd-aegis` | C | 8 | 8 | 0 | 0 | REPRODUCED |
| `usdf-astherus` | C | 6 | 6 | 0 | 0 | REPRODUCED |
| `usdz-anzen` | C | 5 | 5 | 0 | 0 | REPRODUCED |
| `usn-noon` | C | 8 | 8 | 0 | 0 | REPRODUCED |
| `usp-pikudao` | C | 6 | 5 | 0 | 1 | REPRODUCED |
| `yusd-aegis` | C | 7 | 7 | 0 | 0 | REPRODUCED |
| `yusd-yieldfi` | C | 12 | 12 | 0 | 0 | REPRODUCED |
| `zchf-frankencoin` | C | 14 | 14 | 0 | 0 | REPRODUCED |

## Quarantine list

| Asset | Surface | Defect (evidence) | Action |
|---|---|---|---|
| `cgo-comtech` | `domains/reserves/cgo-comtech.json` | REFUTED: `custodyProfile.segregation` changed `segregated`→`unknown`, but the diff's own cited source (live cgold.ae bundle) states gold held "in a complete insurance and segregation" and "identifiable and segregated". Downgrade contradicted by its own evidence. | Full-file revert to `e958a3db1` (staged) |
| `gldt-gold-dao` | `coins/gldt-gold-dao.json` | REFUTED: rationale claims docs.gold-dao.org/other/key-canisters presents GLDT as claim on locked GLD NFTs — that page contains only canister IDs (content mismatch; false citation) and the `compositionAsOf` 2026-07-28 bump rests on it. Substance corroborated elsewhere (FAQ); re-land with an honest citation. | Full-file revert to `e958a3db1` (staged) |
| `cdxusd-cod3x` | `mech-packets/cdxusd-cod3x.json` | REFUTED: `collateralizationParameters: limited` graded on blog/marketing basis only; not D3-admissible (no structured data + external anchor). Metric states reproduce. | `mech-packets/cdxusd-cod3x.REJECTED` |
| `fpi-frax` | `mech-packets/fpi-frax.json` | REFUTED: `contractionCapacity: adequate` over-graded one tier — evidence class is D3-limited (issuer API + eth_call + docs; no independent attestor/filing/oracle). All numerics reproduced. | `mech-packets/fpi-frax.REJECTED` |
| `ftusd-flying-tulip` | `mech-packets/ftusd-flying-tulip.json` | REFUTED: `venueAndCustody`/`unwindCapacity: limited` graded on docs narrative + DefiLlama listing only; no D3 external anchor (packet admits). | `mech-packets/ftusd-flying-tulip.REJECTED` |
| `iauon-ondo` | `mech-packets/iauon-ondo.json` | REFUTED: all seven components `adequate` on issuer-docs-only evidence; D3 adequate needs a pinned independent attestation/filing/oracle (Ankura PDF described, not pinned). | `mech-packets/iauon-ondo.REJECTED` |
| `nwisdom-nest` | `mech-packets/nwisdom-nest.json` | REFUTED: maturityAndLiquidity claims "T+1 Nest estimate" for nWISDOM; cited page (snapshot 2026-07-27 17:20Z) states 4 days for nWISDOM (T+1 is nTBILL/nALPHA/nBASIS/nOPAL/nCLOA only). | `mech-packets/nwisdom-nest.REJECTED` |

## Cross-check failures (KIMI-MECH-2 applied a refuted packet)

None. Overlay `shared/data/safety-score-v9/mechanism-review-overlays-v1.json` is
unmodified (last commit `deadfa904`, pre-wave; working tree clean at audit time), so
KIMI-MECH-2 had applied nothing when the REJECTED markers landed. NOTE: its
`mech2-drafts/` already contained drafts for `cdxusd-cod3x`, `fpi-frax`, `iauon-ondo`
— the markers are in place to stop application; the morning coordinator should
confirm no entry for the five refuted assets appears in KIMI-MECH-2's terminal commit.

## Auditor false positives (overturned on coordinator re-check)

- `nopal-nest`, `nbasis-nest`, `inalpha-nest` (Stream C): swarm auditors reported the
  Nest available-vaults page showed a "July 15 snapshot" with 4-day/7-day redemption
  estimates, refuting the packets' T+1 claims. Coordinator re-fetched the page twice
  (curl + independent extractor): data snapshot **July 27, 2026 17:20 UTC** lists
  nOPAL/nBASIS/nALPHA redemption estimate = **T+1** — GROK's packets match the
  primary source. Verdicts changed REFUTED→REPRODUCED; auditors likely hit a stale
  cache. `nwisdom-nest` REFUTED stands (page says 4 days for nWISDOM).

## UNVERIFIABLE (recorded, no quarantine — coordinator decides)

- `acrdx-anemoy-apollo` (A, MIXED): Chronicle dashboard rate-limited (HTTP 429 ×3) —
  exact holdings/share-count/periodEnd claims unverifiable tonight; score-bearing
  numbers corroborated independently (on-chain VAO read exact match; rwa.xyz within
  0.3%; arithmetic reproduces).

## Poll history / anomalies

- 2026-07-27T22:41Z baseline: main @ `667b757f4`, clean tree, no GROK landings.
- 22:55Z: GROK mid-flight (14 coin JSONs, 10 reserves files, 11 packets).
- 23:20Z: ANOMALY — ~60 out-of-surface files (workflows/hooks/docs/scripts) reverted
  toward pre-`e79359837` CI-gate era by an unattributable process; left untouched.
- 23:35Z: anomaly RESOLVED — deliberate CI restructuring, committed as `e90846c4d` +
  `ad9282130` (later amended to `fc15685af`); zero `shared/data` content.
- 2026-07-28T00:05Z: all four GROK markers + stream commits landed; full swarm audit
  launched. Reverts/markers applied 2026-07-28 ~01:30Z.
