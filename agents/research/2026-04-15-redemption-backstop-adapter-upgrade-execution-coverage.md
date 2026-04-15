# Redemption Backstop Adapter Upgrade Execution Coverage

Date: 2026-04-15

Purpose: map every researched adapter-upgrade opportunity to what was executed, and document valid blockers for work that was not implemented. This prevents the rollout from silently stopping at annotations or first-wave work.

## Fully Implemented

| Candidate | Outcome | Commit(s) | Notes |
| --- | --- | --- | --- |
| Snapshot generation integrity | Implemented | `4e05b086` | `redemption_backstop_runs` manifest and `snapshot_run_id` prevent mixed-generation fresh reads |
| Normalized redemption telemetry contract | Implemented | `4e14099a` | Added `metadata.redemption` typing, parser support, and validation |
| Existing live/proxy flat-to-nested telemetry | Implemented | `46e9e3d1` | Existing capacity/fee adapters now emit nested telemetry while preserving legacy flat fields |
| Cap cUSD | Implemented | `d200cf1e` | New `cap-vault` adapter; cUSD now uses live vault capacity instead of full-supply eventual capacity |
| ERC-4626 asset validation | Implemented | `aeba413c`, `2d9b08f8` | Asset identity failure now degrades; ERC-4626 routes carry documented-eventual provenance |
| OpenEden USDO RLUSD component | Implemented | `20d4f8ab` | USDO adapter no longer fails component-sum validation when `rlusdAmount` is present |
| M0 | Implemented conservatively | `b92e359f` | Adds permissioned/primary-market `live-proxy-validated` telemetry; does not imply broad retail redemption |
| Re Protocol reUSD | Implemented conservatively | `078bf742` | Adds queue/current-capacity telemetry from stablecoin reserves already parsed by the Re adapter |
| Chainlink NAV issuers/funds | Implemented | `a633bdf3` | Adds documented-bound freshness provenance for NAV-backed products |
| Proof/curated adapters | Implemented | `7e94f224` | Adds documented-bound/eventual provenance to `single-asset`, `chainlink-por`, and `curated-validated` |
| DOLA PSM | Implemented | `d09c08fc` | Adds bounded proxy redemption telemetry from stablecoin buckets |
| FDUSD transparency | Implemented | `5794a737` | Adds documented-bound issuer freshness provenance |
| SG-FORGE CoinVertible | Implemented | `d0e1e60a` | Adds documented-bound issuer freshness provenance |
| Circle USDC/EURC | Implemented | `ad1611f5` | Adds documented-bound issuer freshness provenance |
| Frax balance sheet / frxUSD proxy | Implemented conservatively | `d2b28e6a` | Adds live-proxy-validated telemetry from stable reserves; full custodian/coordinator cap probe remains future ABI work |
| Mento reserve dashboard | Implemented conservatively | `2cd7d0b6` | Adds proxy redemption ratio from stable reserve share and source freshness |
| USDD PSM/reserve dashboard | Implemented conservatively | `2cd7d0b6` | Adds proxy redemption capacity from USDT direct/PSM vaults |
| USD1 bundle oracle | Implemented | `d56d236d` | Adds documented-bound provenance to existing verified bundle-oracle reserve proof |
| Safety Score eligibility tightening | Implemented | `67e992fc` | Eventual-only routes no longer uplift Liquidity / Exit by themselves; queue-like routes are capped |

## Partially Implemented With Valid Remaining Work

| Candidate | Executed | Remaining blocker |
| --- | --- | --- |
| Frax frxUSD | Balance-sheet proxy telemetry implemented | Direct custodian/RWA coordinator cap and slippage probes require exact contract ABI/method mapping beyond current repo metadata |
| Frax FPI | Safety policy and research captured; Frax balance-sheet support exists for related assets | FPI controller-pool adapter requires contract-specific ABI/probe implementation; no existing local config path |
| Usual USD0 | Existing `evm-branch-balances` live reserve route already provides current collateral mix; telemetry contract can read nested fields | Direct `DaoCollateral` vs `SwapperEngine` route split requires contract/address mapping and route-specific ABI beyond current metadata |
| Superstate USTB | Existing `chainlink-nav` carries verified NAV provenance | Liquidity API / RedemptionIdle capacity needs product-specific endpoint/contract integration; not available in current config |
| Midas mTBILL | Existing `chainlink-nav` carries verified NAV provenance | Atomic redemption pool / standard queue requires dedicated transparency/API or contract mapping beyond current config |
| Maple syrupUSDC/syrupUSDT | ERC-4626 reserve proof hardened and documented-eventual provenance added | True withdrawal queue depth requires `WithdrawalManagerQueue` address/ABI or GraphQL query integration not present in metadata |
| USD.AI USDai/sUSDai | USD.AI proof-of-reserves feed remains live; research captured split | Direct instant buffer and 30-day queue require app/contract queue state not present in current metadata |
| Falcon USDF | Existing adapter emits queue-style nested telemetry and 7-day delay | Classic vs claim queue path requires a public queue/status endpoint or contract state not documented in repo metadata |
| InfiniFi iUSD | Existing adapter emits queue-style nested telemetry and pending redemption context when present | Timestamp/current route status remains unverified; no trustworthy source timestamp in current API payload |
| Reservoir wsrUSD | Existing adapter emits proxy telemetry but remains unverified/fallback-driven | Product-specific redemption/PSM onchain surface must be verified before stronger capacity is defensible |
| OpenEden TBILL | USDO adapter and RLUSD component fixed; research captured TBILL split | TBILL FIFO queue state needs separate source/endpoint; current adapter is USDO-specific |
| Liquity LUSD/BOLD | `liquity-v1` emits fee provenance and proof-style metadata | V2 BOLD adapter and V1/V2 split require dedicated contract config beyond existing LUSD adapter |
| Hashnote USYC | Existing `chainlink-nav` carries verified NAV provenance | Teller/private-liquidity redemption status requires source beyond current NAV config |
| Paxos/PAXG | PAXG and Paxos stablecoins receive proof/NAV/issuer provenance through existing proof adapters where configured | No public live redemption queue/capacity endpoint found; keep as issuer/proof provenance |
| Tokenized gold / Kinesis | Proof-style provenance supported; Kinesis supply sync already exists separately | Physical redemption thresholds/logistics are not machine-readable capacity |

## Deferred With Valid Blockers

| Candidate | Blocker |
| --- | --- |
| Neutrl NUSD | Final verification found only audit PDFs/roles, no public current queue/capacity/status surface |
| Ondo USDY/OUSG | Product-specific machine-readable redemption capacity/status not found; Chainlink NAV proves NAV, not executable redemption capacity |
| Main Street msUSD | Docs describe cap/cooldown, but no public current cap/queue/cooldown state was found |
| Banking Circle EURI | Strong issuer docs, no current public reserve/capacity feed found |
| Monerium EURe | Good API/payment docs, reserve data not public enough for adapter capacity |
| StraitsX XUSD/XSGD | Reserve disclosure appears PDF/docs-heavy, not a stable current probe surface |
| AllUnity EURAU/CHFAU | Token pages exist, no stable live reserve endpoint confirmed |
| OSL USDGO | Launch/issuer messaging found, no public reserve-report endpoint trusted for a probe |
| USDM, GYEN, JPYC, BRZ, IDRT, TRYB, CADC, TGBP, AUDD, AXCNH | Mostly periodic audits, whitepapers, or no public reserve feed; useful as docs/provenance only |
| Additional CDP routes (`fxUSD`, `feUSD`, `meUSD`, `NECT`, `resupply`, River, BIMA, Quill, Orki, Nerite, USDaf, Ebisu, Parallel, Sonic) | Need per-protocol ABI/health/probe mapping; generic full-supply capacity would be unsafe |
| Additional stablecoin-redeem routes (`AID`, `apxUSD`, `dUSD`, `JupUSD`, `United Stables`, Avalon, Astherus, Resolv, Solstice, YOUSD`) | Need current route app/API/contract status; several are whitelisted or incident-sensitive and should not be upgraded without route availability proof |

## Verification Completed

- Focused adapter suites across all touched reserve adapters: passing
- Redemption source/store/sync/API/report-card snapshot suites: passing
- `npm run check:redemption-backstops`: passing
- `npm run check:stablecoin-data`: passing
- `npm run check:migrations`: passing
- `cd worker && npx tsc --noEmit`: passing
- `npm run lint`: passing
- `npm test`: passing before final merge-gate doc-count fix; merge gate rerun required after this ledger and doc-count commit

