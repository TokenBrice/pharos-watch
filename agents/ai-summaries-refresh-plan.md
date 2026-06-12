# AI Summaries Refresh Plan

Generated: 2026-06-12  
Scope: `data/ai-summaries.json` against `shared/data/stablecoins/coins/*.json` plus live Pharos report-card drift.

## Summary

- Coverage is complete: 401 per-coin metadata files and 401 AI summaries; no missing or extra summary IDs.
- Live staleness queue: 26 summaries have checkable drift from live Pharos data: 8 high, 10 medium, 8 low.
- Text quality queue: 54 summaries are thin (`<80` words or `<3` sentences); 19 of those are very thin (`<50` words).
- Structure queue: 23 summaries start with a visible lowercase/article fragment that reads like a pasted lead sentence rather than polished editorial copy.
- Most summaries still use May facts: 293 summaries have `factsAsOf: 2026-05-15`; only 73 were refreshed on 2026-06-03 and 3 on 2026-06-07.

Target quality bar: use `zchf-frankencoin` and `bold-liquity` as style exemplars. They interpret the reserve mix, peg mechanism, safety profile, and central tradeoff instead of only defining the asset. `bold-liquity` still needs a tiny de-brittling pass because it pins the old exact score (`94`, now `91`), but the narrative structure is otherwise a good model.

## Swarm Execution Status

Workers must update only their assigned row below after completing their batch. Status values: `pending`, `in-progress`, `complete`, or `blocked`.

| Worker | Status | Owned summary IDs | Notes |
| --- | --- | --- | --- |
| W1-live-drift | complete | P0 high/medium plus P3 low drift | Refreshed owned entries, removed stale live-grade/DEWS claims, and de-brittled low-drift exact values. |
| W2-very-thin-examples | complete | Named examples plus very thin entries not owned by W1 | Completed W2 expansions; `zchf-frankencoin` intentionally unchanged as exemplar. |
| W3-thin-early | complete | Remaining thin entries, early slice | Expanded owned 50-64 word entries and cleaned steakUSDT/steakUSDC fragment openings. |
| W4-thin-middle | complete | Remaining thin entries, middle slice | Expanded 12 assigned 65-73 word summaries; JSON/glossary checks passed. |
| W5-thin-late | complete | Remaining thin entries, late slice | Expanded 13 owned 74-79 word summaries with June 12 metadata; wrappers now separate parent stablecoin risk from wrapper risk. |
| W6-structure-cleanup | pending | Structural duplicate/fragment entries not owned by W1-W5 | Clean pasted/fractured openings and duplicate lead sentences. |

## Evidence

- Rendered AI-summary source: `data/ai-summaries.json`.
- Stablecoin metadata source: `shared/data/stablecoins/coins/*.json`.
- Live staleness command: `npm run candidates:ai-summaries` using the API key from `.env.local`.
- Live staleness output: `agents/ai-summary-candidates.md` and `agents/ai-summary-candidates.json`.
- Current named-example live report cards:
  - `bold-liquity`: A+ / 91; dimensions A+ peg, A+ liquidity, A+ resilience, A+ decentralization, A+ dependency.
  - `zchf-frankencoin`: B / 70; dimensions A+ peg, C+ liquidity, B- resilience, A decentralization, B+ dependency.
  - `usdt-tether`: B / 72; dimensions A+ peg, B- liquidity, B resilience, D decentralization, A+ dependency.
  - `usdai-usd-ai`: C+ / 62; dimensions A+ peg, C- liquidity, B- resilience, D decentralization, B+ dependency.
  - `usde-ethena`: C / 57; dimensions A+ peg, C+ liquidity, F resilience, D decentralization, B+ dependency.

## Rewrite Rules

1. Fix high and medium live contradictions first. These are visible grade/DEWS/score contradictions beside the detail page.
2. Do not just swap volatile numbers. Remove or relativize exact DEWS scores, depeg-event counts, and exact numeric safety scores unless the number is the editorial point.
3. Expand thin summaries to 3-6 substantive sentences. Each rewrite should cover what it is, what makes it interesting, the risk/tradeoff, and one Pharos-specific signal.
4. Use current metadata fields before external research: `collateral`, `pegMechanism`, `reserves`, `variantOf`, `variantKind`, `yieldConfig`, `proofOfReserves`, `mintAuthority`, compliance fields, notices, and deployment footprint.
5. Preserve good voice. Do not flatten BOLD/ZCHF-style summaries into generic encyclopedia copy.

## P0 - Live Contradictions

Refresh these before any style-only work.

| Priority | ID | Symbol | What needs updating |
| --- | --- | --- | --- |
| high | `dusd-standx` | DUSD | Summary says D grade at 49 and DEWS Calm at 12; live is score 46, DEWS WATCH, DEWS score 28. Rewrite around active stress instead of pinning DEWS. |
| high | `eurs-stasis` | EURS | Summary says D safety grade; live is F. |
| high | `fidd-fidelity` | FIDD | Summary says B+ safety grade; live is A-. |
| high | `mim-abracadabra` | MIM | Summary says C+ overall grade; live is D. |
| high | `pyusd-paypal` | PYUSD | Summary says A- safety grade; live is B+. |
| high | `reusd-re-protocol` | reUSD | Summary says C+ overall grade; live is B-. |
| high | `usbd-bima` | USBD | Summary says B- overall grade; live is C+. Also appears in fragment-lead queue. |
| high | `veur-vnx` | VEUR | Summary says B grade at 74; live is C at 58. Remove exact score or frame the downgrade. |
| medium | `btcusd-btcfi` | BtcUSD | Summary says DEWS Calm at 15 and 1,000 depeg events; live DEWS score is 10 and depeg count is 1,036. Relativize both. |
| medium | `crvusd-curve` | crvUSD | Summary says B+ report card; live is B. |
| medium | `frax-frax` | FRAX | Summary says C+ safety grade; live is C. |
| medium | `hollar-hydrated` | HOLLAR | Summary says C grade at 55; live is C-. |
| medium | `rlusd-ripple` | RLUSD | Summary says B safety grade; live is B-. |
| medium | `usd0-usual` | USD0 | Summary says C safety grade; live is C-. Also appears in fragment-lead queue. |
| medium | `usdaf-asymmetry` | USDaf | Summary says B- safety grade at 66; live is B at 71. Also appears in fragment-lead queue. |
| medium | `usdcv-societe-generale-forge` | USDCV | Summary says B safety grade at 72; live is B- at 69. |
| medium | `usdf-falcon` | USDf | Summary says C+ safety grade; live is C. |
| medium | `usdp-paxos` | USDP | Summary says B safety grade; live is B+. |

## P1 - Named User Examples

| ID | Current issue | Rewrite focus |
| --- | --- | --- |
| `usdai-usd-ai` | Too short: 34 words / 2 sentences. It also underplays the current PYUSD-backed reserve model. | Explain that base USDai is non-yielding, currently backed by PYUSD in the contract; USDC/USDT are deposit/exit currencies; sUSDai is the separate GPU-loan yield sleeve. Include real-time PoR and centralized mint/admin risk. |
| `usdt-tether` | Too short for the largest stablecoin: 57 words / 4 short sentences. | Add why the B grade is not a peg problem: A+ peg, B- liquidity, D decentralization. Cover Q1 2026 reserves, USDT0 footprint, issuer redemption discretion, quarterly BDO attestation model, and concentrated mint authority / 2019 accidental mint history if useful. |
| `usde-ethena` | Not short, but repetitive and stale-feeling: it says the 76% liquid-stablecoin backing twice and misses the full current custody set. | Rewrite once around the current split: ~76% liquid stablecoins, ~16% BTC delta-neutral, ~8% ETH/LST delta-neutral. Keep the key tension: A+ peg versus F resilience and D decentralization, CEX/custody dependence, and the USDtb -> BUIDL dependency chain. |
| `bold-liquity` | Strong summary, but low drift: exact score says 94, live is 91. | Keep as exemplar; remove or update exact score. Prefer "A+ despite modest scale" over exact score. |
| `zchf-frankencoin` | Strong summary and no live staleness finding. | Keep as exemplar. Future refresh only if collateral mix or grade changes materially. |

## P1 - Thin Summaries

These should be expanded to the BOLD/ZCHF standard. The "add" column names the strongest available metadata currently underused.

| ID | Symbol | Size | Add / emphasize |
| --- | --- | ---: | --- |
| `susd-synthetix` | SUSD | 29w / 2s | SNX/V3 collateral split, prolonged discount, V3/SLP restoration plan, governed mint path. |
| `usd3-reserve-protocol` | USD3 | 29w / 2s | Reserve basket mechanics, yield-bearing USDC/USDS wrappers, RSR governance, real-time Reserve PoR. |
| `djed-coti` | DJED | 30w / 2s | ADA reserve-coin design, SHEN volatility absorption, 400%-800% reserve band, COTI oracle role. |
| `susdd-tron-dao-reserve` | sUSDD | 31w / 2s | Wrapper inheritance from USDD, NAV/yield mechanics, self-reported PoR, not a separate peg mechanism. |
| `tgbp-tokenised` | tGBP | 32w / 2s | GBP reserves/UK government paper, FCA context, issuer mint/redeem model, independent audit. |
| `u-united-stables` | U | 32w / 3s | Variable reserve mix, issuer discretion, real-time dashboard, redemption framing. |
| `euroe-membrane` | EUROe | 33w / 2s | Frozen/past-tense context, Paxos/Membrane decommissioning, redemption-only status. |
| `mmxn-moneta-digital` | MMXN | 33w / 2s | Self-reported MXN reserves, Ethereum/Tron support, missing independent attestation cadence. |
| `cngn-compliant-naira` | cNGN | 34w / 1s | Nigerian SEC oversight, bank deposits vs money-market/FGN T-bills split, multichain settlement role. |
| `syzusd-yuzu` | syzUSD | 34w / 2s | Wrapper over Yuzu USD, Accountable reserve feed, Plasma/Monad split, double-counting risk. |
| `usdai-usd-ai` | USDai | 34w / 2s | PYUSD reserve, USDC/USDT deposit-vs-reserve distinction, sUSDai separation, real-time PoR. |
| `usdp-parallel` | USDp | 36w / 2s | Parallelizer basket, frxUSD/sfrxUSD/USDe collateral, governed exposure limits. |
| `usyc-hashnote` | USYC | 38w / 2s | Circle/Hashnote rebrand, T-bill/repo fund structure, NAV token behavior, issuer controls. |
| `pht-pht` | PHT | 39w / 2s | Maker-style design, apcxUSDT collateral, limited proof path, governance/mint risk. |
| `susdai-usd-ai` | sUSDai | 39w / 2s | GPU loan sleeve, PYUSD liquid sleeve, NAV credit-product behavior, Accountable/PoR context. |
| `aa-falconx-mev-capital` | AA_FalconXUSDC | 40w / 2s | Pareto/FalconX credit vault exposure, USDC wrapper inheritance, private-credit risk. |
| `idrx-idrx` | IDRX | 40w / 2s | IDR fiat + government bonds, audit materials, KYC-gated issuer model. |
| `usn-noon` | USN | 44w / 3s | Private credit/CLO/DeFi/T-bill reserve mix, Accountable feed, off-chain attested minting. |
| `usdpt-western-union` | USDPT | 45w / 3s | Pre-launch settlement use case, Anchorage issuance, Western Union agent/treasury rails. |
| `steakusdt-steakhouse` | steakUSDT | 52w / 3s | Morpho vault strategy, Tether inherited risk, withdrawal/liquidity assumptions. |
| `usdn-smardex` | USDN | 55w / 3s | wstETH delta-neutral vault, unrelated Noble/Neutrino names, permissioned minting. |
| `usdt-tether` | USDT | 57w / 4s | Reserve composition, USDT0, centralized issuer/mint controls, BDO attestations. |
| `scusd-rings` | scUSD | 60w / 3s | Stablecoin collateral plus Veda/Rings strategy exposure, self-reported backing. |
| `apyusd-apyx` | apyUSD | 62w / 3s | apxUSD wrapper, DAT preferred-share collateral, yield-vs-par tension. |
| `mre7yield-midas` | mRe7YIELD | 62w / 3s | Re7 strategy risk, NAV oracle, lack of granular strategy feed. |
| `savusd-avant` | savUSD | 62w / 3s | avUSD wrapper, delta-neutral strategy yield, cooldown/exit path. |
| `gbpe-monerium` | GBPe | 63w / 3s | EMI backing, safeguarded GBP funds, redemption via bank rails. |
| `steakusdc-steakhouse` | steakUSDC | 63w / 3s | Morpho vault construction, Circle inherited risk, curator/withdrawal assumptions. |
| `fxsave-f-x-protocol` | fxSAVE | 64w / 3s | fxUSD Stability Pool exposure, WBTC/wstETH inherited CDP risk. |
| `mhyper-midas` | mHYPER | 65w / 4s | Hyperithm market-neutral strategy, Chainlink NAV, high-risk strategy framing. |
| `mglobal-midas-fasanara` | mGLOBAL | 66w / 4s | Fasanara portfolio, missing/weak live NAV adapter context, permissioned redemption. |
| `onyc-onre` | ONYC | 68w / 3s | Reinsurance portfolio, Apex audit, queue/high-touch redemption design. |
| `pc0000101-tradable` | PC0000101 | 68w / 3s | Legal-finance receivables, off-chain pricing, no $1 peg. |
| `srusde-strata` | srUSDe | 69w / 3s | Senior tranche over USDe, junior loss absorption, Ethena inherited risk. |
| `eurspkcc-spiko` | EURSPKCC | 70w / 4s | Cash-and-carry fund share, T-bill/cash buffer, NAV not euro redemption. |
| `pc0000089-tradable` | PC0000089 | 70w / 3s | LatAm residential credit, off-chain note risk, market-price admission. |
| `mf-one-midas` | mF-ONE | 71w / 4s | Fasanara F-ONE strategy, Midas wrapper, permissioned NAV token. |
| `cdp-enosys` | CDP | 72w / 5s | Flare collateral specifics, Enosys Loans mechanics, governed parameters. |
| `pc0000033-tradable` | PC0000033 | 72w / 4s | Senior secured notes, private-credit exposure, no public yield source. |
| `susn-noon` | sUSN | 73w / 3s | USN wrapper inheritance, NAV appreciation, whitelisted redemption constraints. |
| `uktbl-spiko` | UKTBL | 73w / 4s | UK T-bills/cash reserve, Spiko gatekeeping, NAV-fund framing. |
| `asusdf-astherus` | asUSDF | 74w / 4s | USDF staking wrapper, Binance/MirrorX strategy inheritance, queue redemption. |
| `eursafo-spiko` | EURSAFO | 74w / 4s | Overnight swap MMF exposure, AMF/UCITS context, NAV-fund framing. |
| `sfrxusd-frax` | sfrxUSD | 74w / 3s | frxUSD wrapper, custodian/reserve assumptions, savings sleeve mechanics. |
| `hbusdt-hyperbeat` | hbUSDT | 76w / 4s | USDT/USDT0 inherited risk, Hyperbeat strategy split, Accountable feed. |
| `scrvusd-curve` | scrvUSD | 76w / 4s | crvUSD savings share, borrower interest, inherited CDP/LLAMMA risk. |
| `syusd-aegis` | sYUSD | 76w / 4s | YUSD staking wrapper, BTC delta-neutral inheritance, cooldown exits. |
| `sdola-inverse-finance` | sDOLA | 77w / 4s | DOLA wrapper mechanics, FiRM/DBR auction revenue, exchange-rate risk. |
| `srusd-reservoir` | srUSD | 77w / 3s | Reservoir balance sheet, savings wrapper inheritance, real-time PoR. |
| `hchf-hedera-swiss-franc` | HCHF | 78w / 4s | HBAR troves, Liquity-style immutability, tiny CHF liquidity. |
| `stac-securitize` | STAC | 78w / 4s | AAA CLO fund, Securitize administration, NAV not $1 redemption. |
| `mapollo-midas` | mAPOLLO | 79w / 4s | Apollo Crypto strategy, Midas rails, high-risk strategy exposure. |
| `mmev-midas` | mMEV | 79w / 4s | MEV Capital strategy mix, Chainlink NAV, not transactional stablecoin. |
| `qcad-stablecorp` | QCAD | 79w / 4s | VRCA/FINTRAC regulation, live CAD reserve API, small-market context. |

## P2 - Structural Cleanup

These are not necessarily factually wrong, but the opening reads mechanically pasted or redundant. Fix during the same rewrite pass if the coin is also in P0/P1.

### Fragment Leads

| ID | Symbol | Issue |
| --- | --- | --- |
| `money-defi-money` | MONEY | Opens with `crvUSD-style...` fragment. |
| `steakusdc-steakhouse` | steakUSDC | Opens with lowercase article fragment. |
| `steakusdt-steakhouse` | steakUSDT | Opens with lowercase article fragment; also thin. |
| `stkgho-umbrella-aave` | stkGHO.v1 | Opens with lowercase article fragment. |
| `stusd-stoneyield` | stUSD | Opens with lowercase article fragment. |
| `suiusde-sui` | suiUSDe | Opens with lowercase article fragment. |
| `susd-hedgecore` | SUSD | Opens with lowercase article fragment. |
| `susd-solayer` | sUSD | Opens with lowercase article fragment. |
| `susdc-spark` | spUSDC | Opens with lowercase article fragment. |
| `susde-ethena` | sUSDe | Opens with lowercase article fragment and repeats the wrapper definition. |
| `susds-sky` | sUSDS | Opens with lowercase article fragment. |
| `susdt-spark` | spUSDT | Opens with lowercase article fragment. |
| `syrupusdc-maple` | syrupUSDC | Opens with `one of...` fragment. |
| `syusd-aegis` | sYUSD | Opens with lowercase article fragment; also thin. |
| `thbill-theo` | thBILL | Opens with lowercase article fragment. |
| `tryb-bilira` | TRYB | Opens with lowercase article fragment. |
| `usbd-bima` | USBD | Opens with lowercase article fragment and has live grade drift. |
| `usd-nubank` | USD-NU | Opens with lowercase article fragment. |
| `usd0-usual` | USD0 | Opens with lowercase article fragment and has live grade drift. |
| `usd1-world-liberty-financial` | USD1 | Opens with lowercase article fragment. |
| `usda-alpha-partner` | USDA | Opens with lowercase article fragment. |
| `usda-avalon` | USDA | Opens with lowercase article fragment. |
| `usdaf-asymmetry` | USDaf | Opens with lowercase article fragment and has live grade drift. |

### Duplicate Lead Review

The full similarity scan is noisy because some summaries intentionally use a TL;DR lead before the narrative. These are the clearest cleanup candidates from very high first/second sentence overlap, plus `usde-ethena` because the user called it out.

| ID | Symbol | What to clean up |
| --- | --- | --- |
| `cusdo-openeden` | cUSDO | First two sentences both define the same non-rebasing USDO wrapper. |
| `eusd-telcoin` | eUSD | First two sentences both define Telcoin Digital Asset Bank issuance. |
| `usdglo-glo` | USDGLO | First two sentences both define Brale/Glo Dollar reserve-yield model. |
| `usdon-ondo` | USDon | First two sentences both define Ondo Global Markets settlement cash. |
| `usp-pareto-credit` | USP | First two sentences both define Pareto private-credit backing. |
| `wemix-dollar-wemix` | WEMIX$ | First two sentences both define native WEMIX dollar token. |
| `usdk-orki` | USDK | First two sentences both define Liquity V2 on Swellchain. |
| `vbill-vaneck` | VBILL | First two sentences both define VanEck Treasury fund share. |
| `isc-international-stable-currency` | ISC | First two sentences both define purchasing-power basket. |
| `wclp-ripio` | WCLP | First two sentences both define Ripio CLP wFIAT. |
| `axcnh-anchorx` | AxCNH | First two sentences both define CNH cash reserves. |
| `gtusdcp-gauntlet` | gtUSDCp | First two sentences both define Gauntlet MetaMorpho V2 vault. |
| `mmev-midas` | mMEV | First two sentences both define Midas/MEV Capital strategy token. |
| `safo-spiko-usd` | SAFO | First two sentences both define Spiko/Amundi Smart Cash exposure. |
| `sofid-sofi` | SOFID | First two sentences both define SoFi bank-issued stablecoin. |
| `paxg-paxos` | PAXG | First two sentences both define federally regulated gold token. |
| `susde-ethena` | sUSDe | First two sentences both define yield wrapper; also fragment lead. |
| `usde-ethena` | USDe | Repeats the 76% liquid-stablecoin restructure in consecutive sentences. |

## P3 - Low Drift / Opportunistic Debrittling

These are lower urgency, but should be adjusted when touching the same entry.

| ID | Symbol | What needs updating |
| --- | --- | --- |
| `bold-liquity` | BOLD | Exact score says 94; live is 91. Keep the good narrative and de-brittle the number. |
| `cgusd-cygnus-finance` | cgUSD | Peg score says 77; live is 80. |
| `gyen-gyen` | GYEN | Depeg count says 72; live is 70. |
| `ousd-origin-protocol` | OUSD | Depeg count says 181; live is 144. |
| `pmusd-precious-metals` | pmUSD | Depeg count says 450; live is 456. |
| `satusd-river` | satUSD | Depeg count says 200; live is 225. |
| `usdb-blast` | USDB | Depeg count says 1,346; live is 1,355. |
| `usdm-moneta` | USDM | Exact score says 32; live is 35. |

## Suggested Batch Order

1. Batch A: P0 high and medium drift only. Rerun `npm run candidates:ai-summaries` after edits and require zero high/medium findings.
2. Batch B: User-visible examples and very thin summaries: `usdai-usd-ai`, `usdt-tether`, `usde-ethena`, plus all `<50` word entries.
3. Batch C: Remaining thin summaries from 50-79 words.
4. Batch D: Fragment leads and duplicate-lead cleanup, prioritizing entries already edited in batches A-C.
5. Batch E: Low-drift de-brittling.

## Verification

After each edit batch:

```bash
npm run candidates:ai-summaries
npm run check:glossary-coverage
npm run typecheck
```

Before release, because this touches Pages-visible copy:

```bash
npm run test:merge-gate
```
