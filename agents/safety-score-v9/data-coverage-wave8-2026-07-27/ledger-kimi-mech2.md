# KIMI-MECH-2 ledger — mechanism overlay drain, rotation 2 (2026-07-27 night shift)

Surface: `shared/data/safety-score-v9/mechanism-review-overlays-v1.json` (304 → 327 entries)
+ `shared/data/safety-score-v9/mechanism-measurements/**` (42 journal sets). Admissibility:
`docs/process/mechanism-overlay-evidence-standard.md` (D3) + D2 partial-metric commit 8a20f67d0.
Method: 11 parallel research shards → 14 independent re-verification shards (verdicts in
`mech2-drafts/verdicts/`) → ONE serial applier. Research drafts in `mech2-drafts/`, apply
pipeline in `mech2-apply/`.

**Sealed-replay statement:** offline replay of the pinned envelope is sealed tonight (registry
re-key). No score, counter, or mover claims are made here. Acceptance gates run and green:
MechanismReviewOverlaySchema validation per entry, focused vitest after every ~10 entries and
at terminal (`safety-score-v9-extension-mechanism` 15 + `safety-score-v9-archetype-profiles` 5,
20/20), fact-set 61 + manifest 11 + veritas identity 1 (73/73), journal producer suites 48/48,
eslint clean on changed TS, `git diff --check` clean. Evaluation-build manifest regenerated at
terminal → `5eb13675f4ecf733…`. The morning coordinator owns mover attribution at the first
post-deploy capture.

## Queue 1 — RESEARCH-NEEDED deferral assets (33)

**SKIP(already-current) (10):** stac-securitize (07-24, closed row), hbd-hive (07-22, closed
row), iusd-indigo-protocol, usdh-hubble, fxd-fathom, euro3-3a-dao, mai-qidao,
money-defi-money, nect-beraborrow, usdrif-rif (all reviewedAt 2026-07-27).

**APPLIED (22)** — lane research drafts, independently re-verified against primary sources:

- usdp-parallel — CR 1.039940 (transparency inventory + 8-chain supply pins + Parallelizer
  diamond @25627275); backstop limited (Insurance Fund multisig 17,855.61 USDC @25627275). VERIFIED.
- bnusd-balanced — CR 2.078260 @Sonic 76609151 (facilitator debt + 50-borrower SODAX backing,
  whale concentration disclosed); shutdownAndBadDebt left bounded (no docs exist). VERIFIED-WITH-NITS.
- buck-bucket-protocol — insert. CR 0.146773, LCR 0.038733 @Sui checkpoint 303739938; weak
  grades pinned to measured deficiencies (frozen oracles since 2026-07-03, 22,077.77 BUCK bad
  debt). VERIFIED (full independent re-derivation).
- jpyt-dephaser — supply == DepositManager.totalMintedJpy on Optimism+Base (7,633,444.71);
  reserves/deposits 1.1089; shutdownAndBadDebt newly limited; backstop deliberately bounded. VERIFIED.
- sbold-k3-capital — totalAssets 7,719,437.63 BOLD @25627256; inherited Liquity SP coverage
  70.5% → backstop adequate; branchIsolation → adequate (60/30/10 weights on-chain). VERIFIED.
- cdxusd-cod3x — refreshed replacement: facilitator Safe holds dust only @Base 49201813
  (backing in undisclosed venues); nondisclosure recorded. VERIFIED. Disclosure remains
  issuer-undisclosed; entry documents the search.
- usp-pikudao — insert; all sdn metrics unavailable; supply/NAV-oracle pins @25627271;
  venueAndCustody limited. VERIFIED-WITH-NITS.
- usdf-astherus — insert; all unavailable; supply 111,986,088.08 + zero USDT at mint @BSC
  112517992; no components (Ceffu prose below D3 limited). VERIFIED-WITH-NITS.
- asusdf-astherus — insert; wrapper NAV 1.064858 @BSC 112517992; venueAndCustody limited
  (notes corrected to 4-of-7 Safe per verifier). VERIFIED-WITH-NITS.
- yusd-yieldfi — vault re-read @25627267 bit-identical; metrics 0.99/0/0 stand;
  fundingBasisStress stays bounded (transparency API unpinnable). VERIFIED-WITH-NITS.
- usdv-solomon — hedgeCoverageRatio 0.683144 (itemized Ceffu/Binance API snapshot
  2026-07-27T00:12Z); hedgeReconciliation/lossAbsorption weak (measured shortfalls);
  venueShares recomputed. VERIFIED-WITH-NITS.
- iauon-ondo — insert; WAM not-applicable (FMA Final Terms verbatim: no fixed maturity,
  perpetual grantor trust); valuationCadenceDays 1 (Ankura daily covenant); seven components
  adequate on FMA-filed prospectus evidence. VERIFIED (clauses re-fetched verbatim).
- reusd-re-protocol — insert; Chainlink Re Reserves feed 179,147,152.27 @Avalanche 91393580;
  cadence 1; WAM unavailable; valuationCadence/custody adequate (Network Firm AUP), weak
  grades on documented terms. VERIFIED-WITH-NITS.
- apyusd-apyx — insert; wrapper reads @25627196 (rate 1.40248806); WAM unavailable; cadence
  30 (Wolf & Company monthly). VERIFIED.
- stcusd-cap — WAM 2.999366 (packet's on-chain-derived value substituted for
  dashboard-rounded 3.000821); legalEnforceability newly weak (Cap ToS claim-release). VERIFIED-WITH-NITS.
- iusd-infinifi — WAM 21.422433 recomputed from protocol API (11 dated farms);
  legalEnforceability stays bounded (terms page unpinnable). VERIFIED.
- usn-noon — insert; Accountable live feed (reserves $34.40M vs supply 33.93M @22:45:43Z);
  cadence 0.0105 measured from recurring ~15-min signed snapshots; WAM unavailable;
  legalEnforceability limited added from packet (basis confirmed). VERIFIED-WITH-NITS.
- susn-noon — insert; same feed, sUSN NAV 1.21072033 confirmed on-chain; cadence 0.0105. VERIFIED-WITH-NITS.
- rusd-reservoir — insert; reserves API $35.59M/$35.29M; cadence 0; WAM ruled UNAVAILABLE by
  the verifier (draft's 0-day assumption for the 45.16% Sentora PRIME sleeve = prohibited
  derivation per the ONyc precedent); seven components limited. DISCREPANCY→amended.
- srusd-reservoir — insert; same shared balance sheet, same WAM amendment. DISCREPANCY→amended.
- fusd-freedom-dollar — reserve panel + Zano daemon pin @height 3790223; metrics
  0.735368/0.264632/1.502072; emergencyRecovery/lossRecovery remain bounded. VERIFIED.
- fpi-frax — profileReview refresh from collateral API @25627253: exo 0.871, reflexive 0.0,
  contraction 0.871 (entry's established convention preserved); undisclosed facts unchanged.
  VERIFIED. Required updating the archetype-profiles test clock (2026-07-25 → 2026-07-28) and
  its FPI expectations — the test snapshots this entry's values.

**BLOCKED(issuer-undisclosed) (1):**
- xai-silo-finance — Silo deprecation wind-down (SiloDAO thread 443, executed 2024-04-22;
  residual supply 5,358,653.23 @25627256). No metrics fabricated for a dead protocol;
  lifecycle ruling belongs to the morning coordinator. Journal in `mech2-drafts/journals/`.

## Queue 2 — Grok mech-packets (38 received; stream C complete)

**APPLIED (20):**
- alusd-alchemix — both metrics not-applicable (MCR 2.0 pin @25627228, no global accessor);
  branchIsolation n-a→limited deliberate. VERIFIED-WITH-NITS.
- btcusd-btcfi — merged: CR 1.308384; retained existing branchIsolation/structuralRedemption
  and the 50%-mint-cap caveat. VERIFIED-WITH-NITS.
- reusd-resupply — CR 1.076367, LCR 0.079132 @25627260 (bit-exact); all 6 comps. VERIFIED-WITH-NITS.
- zchf-frankencoin — CR 1.650843 @25627132; ChainSecurity audit source retained. VERIFIED-WITH-NITS.
- dusd-standx — all unavailable; nondisclosure reproduced (API 404s, FAQ narrative-only). VERIFIED.
- mapollo-midas — all unavailable; honest named-search nondisclosure. VERIFIED.
- mhyper-midas — all unavailable; venueAndCustody/hedgeReconciliation/unwindCapacity with
  on-chain attestation pins @25627252. VERIFIED.
- mmev-midas — all unavailable. Wind-down concern resolved: the 2026-05-10 event was the MEV
  Capital→RockawayX manager transition; asset is live (supply 2,196,863.97, NAV fresh). The
  wave-6 ledger's wind-down note should be corrected. VERIFIED.
- mre7yield-midas — all unavailable. VERIFIED.
- susd1plus-lorenzo — all unavailable; incomplete-equity slice (~1.55%) reproduced. VERIFIED.
- nbasis-nest — hedgeCoverage 1.0 measured, others unavailable (deliberate measured-0→unavailable
  change vs 07-20); unwindCapacity basis corrected to 4-day. VERIFIED-WITH-NITS.
- nusd-neutrl — 1 / 4.065999 / 0.04066 from Accountable pin; block-pinned supply reproduced
  to the wei @25627233; hedgeCoverage=1 honestly labeled documented-policy. VERIFIED.
- syusd-aegis — 1 / 0.315224 / 0.016992 Accountable pin exact; docs.aegis.im source retained. VERIFIED-WITH-NITS.
- yusd-aegis — same shared pin; venueShares recomputed. VERIFIED.
- inalpha-nest — WAM unavailable; cadence 0.0417 (hourly NAV, on-chain getRate match). VERIFIED.
- nopal-nest — WAM unavailable; cadence 0.0417 via accountantState/getRate @25627239 — the
  wave-6 cadence block genuinely resolved by primary on-chain evidence. VERIFIED.
- nwisdom-nest — cadence hourly directly observed; maturityAndLiquidity text corrected to 4-day. VERIFIED-WITH-NITS.
- mf-one-midas — WAM unavailable; cadence 1 (oracle rounds 248–253 business-day gaps); all 7 comps. VERIFIED-WITH-NITS.
- said-gaib — WAM unavailable; cadence 30 (monthly NAV verbatim). VERIFIED-WITH-NITS.
- usdz-anzen — both metrics unavailable (true rationales); creditQuality/legalEnforceability/
  custody bases verbatim. VERIFIED.

**REJECTED(packet-unverified) (1):**
- ftusd-flying-tulip — packet's all-metrics-`unavailable` rationale is FALSE: the issuer
  dashboard API pinned in the existing 2026-07-20 overlay is live and still publishes
  TVL/supply/strategy data (verifier recomputed marginBufferPct ≈0.0245, lossAbsorptionShare
  ≈0.000245 from it). Landing would have stripped measured metrics and three components.
  Existing entry untouched. Discrepancy: omitted load-bearing source + false nondisclosure claim.

**REJECTED — superseded by lane draft (17 overlap packets):** every overlap packet was
re-verified alongside the draft; the draft landed in each case. Packets with verification-found
discrepancies: jpyt-dephaser (unevidenced Pyth claim, wrong liquidationMechanics grade),
sbold-k3-capital (backstop limited contradicted by measured 70.5% SP coverage), cdxusd-cod3x
(blog-only basis), usp-pikudao (Ethena/Aave basis unsupported; two components below D3),
rusd/srusd-reservoir (cadence 1 contradicts on-chain-readable balance sheet; its WAM-unavailable
disposition was adopted into the draft), fpi-frax (contraction 2.3651 silently redefines the
profileReview field; unwind depth undisclosed), usn/susn-noon (cadence 1 unmeasured — draft's
0.0105 measured; custody adequate overclaims the feed), reusd-re-protocol (grade conflicts —
evidence supports the draft's documented-deficiency weaks), apyusd-apyx (three grade deviations
unsupported), stcusd-cap (partially adopted: on-chain WAM 2.999366 landed). Packets verified
consistent but redundant (draft equal-or-richer): iauon-ondo, usdf-astherus, asusdf-astherus,
yusd-yieldfi, fusd-freedom-dollar.

## Notes for the morning coordinator
- No mover attribution tonight — sealed replay; first post-deploy capture owns it.
- xai-silo-finance needs a lifecycle (deprecation) ruling, not an overlay.
- ftusd-flying-tulip: existing 07-20 entry is sound; a fresh re-pin of the live dashboard is
  the correct next action, not Grok's unavailable-state packet.
- mmev-midas: wave-6 ledger's "wind-down 2026-05-10" should be corrected to the MEV
  Capital→RockawayX manager transition.
- wsrusd-reservoir's 07-20 figures are stale vs tonight's rUSD/srUSD read (Sentora PRIME now
  45.16% of the book); consider a refresh next wave.
- ybold-yearn vs sbold-k3-capital: wrapper CR/LCR conventions differ (parent-measured vs
  not-applicable); a cross-entry consistency ruling may be wanted.
- Test change: `safety-score-v9-archetype-profiles.test.ts` clock bumped 2026-07-25 →
  2026-07-28 with FPI expectations updated to the new measured profile (0.871/0.0/0.871).
