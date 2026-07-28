# Wave-6 PACKET(mechanism) drain — 2026-07-27

Coordinator drain of `results/curation-wave6-2026-07-22/PACKET-QUEUE.md` (66 mechanism rows;
the 12 exit-output rows stay with the wave-7 KIMI-EXIT lane). Verification basis: live
envelope `report-cards:9.0:1785168098`, replay pair `measurement-2026-07-27/replay-v9.json`
→ `replay-v9-postdrain.json`, registry pair `missing-data-registry-2026-07-27.json` (1,211)
→ `missing-data-registry-postdrain.json` (1,204).

## Outcome

- Registry: 1,211 → 1,204 open items (satusd −4, cdp-enosys −3; issuer-undisclosed 615 → 608).
- Score movers: exactly ONE — satusd-river F 31 → 33 (component grades landed; F held by other
  clauses). cdp-enosys 59/C unchanged (evidence cleared score-neutrally). Pins
  u-united/eurs/mim/tusd byte-identical.
- Identity: evaluation-build manifest regenerated → `1464a5547b7c…`. Focused battery green
  (archetype-profiles 5, coverage/fact-set/manifest 81 total). Score-bearing local commit;
  owner reviews before push.

## STRUCTURAL FINDING (the reason the queue sat undrained)

The overlay contract (`safety-score-v9-extension-mechanism.ts:404-425`) admits partial
metric sets ONLY for the cdp archetype (`metricApplicability` not-applicable + null).
For synthetic-delta-neutral and rwa-credit-fund, ALL archetype metrics must be numeric
("Only CDP overlays support structurally not-applicable metrics"), and fiat-cash/tbill
components are compiler-bounded pending the FORGE owner evidence standard. Most packets
carry honest partial data (some components + some metrics), which the schema cannot admit
→ they are undrainable without either fabrication (forbidden) or an ENGINE CAPABILITY:
extend metricApplicability/null-metric admission to non-CDP archetypes. That is an
identity-bound methodology change = owner decision. Until ruled, the packets below marked
SCHEMA-BLOCKED cannot land regardless of research quality.

## Terminals (66 mechanism rows)

**APPLIED (2):**
- satusd-river — UPDATE: +backstop weak, +branchIsolation limited, +shutdownAndBadDebt
  limited, +structuralRedemption adequate; CR refreshed 1.5958 → 1.604538471769779
  (2026-07-22T18:00Z snapshot); redemption-doc source added. Cleared 4 registry items.
- cdp-enosys — UPDATE: +backstop adequate (SP/supply 0.851917), +shutdownAndBadDebt limited,
  +structuralRedemption adequate; block-65612597 re-read anchor added. Cleared 3 items.
  Grade calibration precedent: bold(0.658→backstop adequate)/ebusd(0.188→limited)/
  satusd(0.001→weak); shutdownAndBadDebt=limited matches lusd/bold mainline.

**CONFLICT — needs mechanism-classification ruling (1):**
- jpym-mento — packet measured Liquity-fork CDP state (CR 1.679490127255, SP 0) from
  deployments-v2 contracts, but the standing 07-15 overlay explicitly rules CR/liqCap
  NOT-APPLICABLE (Mento FPMM reserve/conversion token). Same dispute family as the kesm
  archetype reclassification. Do not overwrite either way without an owner/methodology
  ruling on which mechanism backs jpym.

**SCHEMA-BLOCKED — research usable the moment partial-metric admission ships (5):**
- apxusd-apyx (rwa: full 7-component packet + valuationCadenceDays=30 ready; WAM honestly
  unavailable — entry drafted this session and reverted on validator rejection)
- usdf-falcon (sdn: venueAndCustody/lossAbsorption + lossAbsorptionShare=0.007929781851 +
  venueShares ready; hedgeCoverageRatio/marginBufferPct honestly unavailable — drafted and
  reverted likewise)
- rwausdi-multipli (rwa: measured aggregate CR 3.076843 doesn't map to WAM/cadence metrics)
- usd3-3jane (rwa: composition split 20.1/79.9 only)
- onyc-onre (rwa: single component seniority=unavailable; nothing admissible)

**OWNER-GATED archetype (fiat-cash/tbill compiler-bounded; FORGE evidence standard) (11):**
jtrsy-anemoy, vbill-vaneck, thbill-theo, ntbill-nest, frax-frax, fusd-finchain,
gbpe-monerium, usdu-usdu-finance, susdt-spark, xo-exodus, emxn-telcoin.

**BLOCKED(issuer-undisclosed) — packet itself documents that no measured data exists (12):**
silk-shade-protocol, vcred-vcred, home-homecoin, mapollo-midas, mmev-midas (wind-down
2026-05-10), dusd-standx, nopal-nest (WAM/cadence BLOCKED per packet), inalpha-nest,
nwisdom-nest, gldy-streamex, hlscope-hamilton-lane, aa-falconx-mev-capital.

**BLOCKED-honest, existing entry already carries all admissible data (2):**
- ftusd-flying-tulip (sole gap fundingBasisStress: "lacks independent pinned reconciliation")
- btcusd-btcfi (gaps backstop/shutdownAndBadDebt: packet states no source establishes them)

**RESEARCH-NEEDED — deferral packets with only a doc link; wave-7 KIMI-MECH lane (33):**
stac-securitize†, hbd-hive†, iauon-ondo, cdxusd-cod3x, usdp-parallel, iusd-indigo-protocol,
usdh-hubble, bnusd-balanced, fxd-fathom, euro3-3a-dao, mai-qidao, usp-pikudao,
xai-silo-finance (deprecation wind-down — consider lifecycle ruling instead), jpyt-dephaser,
reusd-re-protocol, apyusd-apyx, usdf-astherus, stcusd-cap, iusd-infinifi, usn-noon,
susn-noon, buck-bucket-protocol, money-defi-money, fusd-freedom-dollar, yusd-yieldfi,
sbold-k3-capital, fpi-frax, asusdf-astherus, usdv-solomon, srusd-reservoir, rusd-reservoir,
nect-beraborrow, usdrif-rif.
† stac/hbd: already applied pre-drain (07-24/07-22 entries); no open mechanism gap — closed rows.

Note: several RESEARCH-NEEDED assets are cdp archetype (usable today); the sdn/rwa ones in
that list will ALSO hit the schema wall unless the partial-metric capability ships first —
sequence the owner decision before dispatching KIMI-MECH for maximum yield.

## RESOLUTION 2026-07-27 late — jpym CONFLICT settled (commit deadfa904)

On-chain verification (owner ruling: evidence decides) confirmed the wave-6 packet's CDP
reading: JPYm is backed by the Mento Liquity-v2 deployment (BorrowerOperationsv300JPYm
mints; sole active trove 171,960 USDm vs 16,596,009 JPYm debt, CR ~1.695 on 2026-07-27);
the BiPoolManager minter role is legacy-inert. Overlay updated with the block-pinned
wave-6 metrics (CR 1.679490127255 @ Celo 72133274, SP 0 -> backstop weak). Residual:
bootstrap-era mint history of the legacy BorrowerOperations address unruled. NOTE: this
verdict is JPYm-specific — do NOT generalize to kesm/cadm-class assets, which were
reclassified off cdp on their own pinned analytics.

## CORRECTION 2026-07-28 — mMEV wind-down label

The original `mmev-midas (wind-down 2026-05-10)` row above is retained for audit history
but its lifecycle label is corrected. Post-wave verification identified the relevant
event as the MEV Capital → RockawayX strategy-manager transition, not a terminal asset
shutdown. At the correction review, mMEV remained live with Ethereum `totalSupply()` of
2,196,863.97 tokens and a freshly updating NAV feed. See RockawayX's
[manager-transition announcement](https://www.linkedin.com/pulse/rockawayx-assumes-strategic-management-midas-mmev-mevbtc-vaults-6nrsc),
the [Ethereum token contract](https://etherscan.io/token/0x030b69280892c888670edcdcd8b69fd8026a0bf3),
and the live [CoinGecko mMEV listing](https://www.coingecko.com/en/coins/midas-mmev).
