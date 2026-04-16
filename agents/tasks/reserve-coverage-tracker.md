# Reserve Coverage Tracker

> Tracks open coverage candidates that are NOT being shipped in Phase 4 of the 2026-04-16 reserve sync remediation plan, plus issuer/source items waiting on external action.

> Date established: 2026-04-16

> Source plan: `agents/plans/2026-04-16-reserve-sync-remediation-and-expansion.md` (Task 7.3)

> Review cadence: monthly — re-check for new issuer announcements or data-source availability.

---

## Scope

This tracker is the single place Phase 7 collects deferred reserve coverage work. It excludes coins in active Phase 4 tasks (MIM, LisUSD, BUIDL-if-feed-exists, PYUSD, pUSD, USDat, USDtb, FPI, CJPY, USDK, ebUSD) to avoid duplication.

---

## Waiting on issuer

External action required by the issuer before any adapter work can unblock coverage.

| Coin | Gap | Expected signal | Notes |
|---|---|---|---|
| `usx-solstice` | Chainlink Proof-of-Reserve feed not yet live | Issuer announcement that Chainlink PoR is deployed | Monitor. When PoR ships, replace the current proof-class solstice-attestation adapter with a `chainlink-por` feed for independent evidence. |
| `usdy-ondo-finance` | Chainlink USDY oracle lacks a payload-native disclosure timestamp suitable for the scoring-eligible freshness gate | Ondo publishes an alt oracle or adds a verified source timestamp path | Until then USDY stays outside independent live collateral passthrough. |
| `fdusd-first-digital` | Current FDUSD transparency HTML is the only attestation surface and the feed publishes stale timestamps between audits | Fresh issuer attestation with a machine-parseable monthly cadence | Adapter already exists; gap is source freshness, not coverage. |
| `uty-upstream` | Upstream refresh required from issuer — no reliable public endpoint for reserve composition today | Issuer-published reserves endpoint or refreshed attestation | Currently has no live adapter; waiting for issuer to publish usable data. |

GHO Path D contract addresses (see Phase 7 Task 7.1 below) are also issuer-dependent until Aave documents verified deployment addresses for the `GhoReserve` / `GhoDirectFacilitator` / RemoteGSM family.

---

## Weak-probe ceiling by data availability

Coins where the upstream source is genuinely opaque at the asset-composition level. No adapter work can promote these beyond `weak-live-probe` until the issuer or a third party publishes structured, timestamped, per-asset data.

| Coin | Evidence class today | Ceiling reason |
|---|---|---|
| `kau-kinesis` | weak-live-probe | Kinesis publishes PDF-only commodity audits; no structured per-asset feed. |
| `pmusd-precious-metals` | weak-live-probe | PDF-only commodity audits; no structured per-asset feed. |
| `cgo-comtech` | weak-live-probe | PDF-only commodity audits; no structured per-asset feed. |
| `mxnb-juno` | weak-live-probe | MXNB transparency scraper deferred (page exposes only aggregate MXN vs MXNB ratio, no asset breakdown; would deliver less than curated). Re-evaluate if Juno publishes per-asset breakdown. |
| `usdz-anzen` | weak-live-probe | Per-asset SPCT portfolio snapshots + attestation timestamps are not published. See `agents/plans/usdz-spct-promotion-gate.md` for the evidence gate. |

---

## Manual issuer research required

Coverage work is blocked on manual issuer outreach rather than on implementation.

| Coin | Gap |
|---|---|
| `usda-avalon` | Avalon does not publish a reviewed reserve composition surface. Need direct issuer contact. |
| `usdf-astherus` | Astherus reserve breakdown not published; no known structured endpoint. |
| `dusd-standx` | StandX reserves not public; requires issuer contact for attestation schema. |

---

## Requires new chain adapter infrastructure

Coins whose reserve sources live on chains Pharos Workers do not yet support. Implementation is blocked on chain-family scaffolding, not on per-coin adapter design.

| Coin | Chain | Blocker |
|---|---|---|
| `buck-bucket-protocol` | Sui | No Sui chain adapter infra in Workers. |
| `uusd-youves` | Tezos | No Tezos chain adapter infra in Workers. |
| `silk-shade-protocol` | Secret Network | No Secret Network adapter infra in Workers. |
| `hollar-hydra-collateralized` | Hydration | No Hydration/Polkadot adapter infra in Workers. |

---

## Candidate but deferred

Feasible adapter work that was out of scope for the 2026-04-16 plan.

| Coin(s) | Adapter family | Notes |
|---|---|---|
| `xaut-tether`, `paxg-paxos` | `chainlink-por` gold feeds | Chainlink has gold PoR feeds; wire them in a later wave once the feed addresses and decimals are confirmed. |
| `eurs-stasis`, `xsgd-straitsx` | Issuer attestation scrapers | Both publish attestation PDFs on fixed URLs; needs a scraper-and-validate adapter pass. |
| `alusd-alchemix` | New adapter | Alchemix's collateral surfaces are fragmented; requires a dedicated adapter design. |
| `msusd-metastreet` | New adapter | Protocol-specific reserve read needed. |
| `usdp-paxos` | New adapter | Paxos publishes transparency; needs a discrete adapter rather than reusing FDUSD's scraper. |

---

## Phase 7 Task 7.1 — GHO Path D follow-up

- The GHO reserve adapter already decomposes residual issuance across active facilitators and feeds unmapped residuals through the standard `material-unknown-exposure` validator (Task 2.5 + Task 7.1a). No `aggregated-residual-issuance` warning remains.
- Path D (direct `GhoReserve` / `GhoDirectFacilitator` / RemoteGSM reads) could not be completed in Phase 7 because verified mainnet/L2 contract addresses are not available in the governance forum post, AIP 452, or AIP 453. Only the USDC and USDT GSM fee strategy contracts were published explicitly.
- **Action when unblocked:** once Aave publishes verified deployment addresses for `GhoReserve` / `GhoDirectFacilitator` / `RemoteGSM` on mainnet and each supported L2, extend `worker/src/cron/reserve-adapters/gho.ts` with a configurable per-facilitator tracked module list (keyed by address + label) and a per-address risk override so unknown residual exposure shrinks without heuristic label matching.
- **Source to watch:** https://governance.aave.com/t/remotegsm-upgrade-enabling-l2-gsms-for-gho/24240

---

## Phase 7 Task 7.2 — USDz / SPCT evidence gate

- Full evidence gate: `agents/plans/usdz-spct-promotion-gate.md`.
- Current state: `anzen-usdz` remains `weak-live-probe`.
- No change is planned until the issuer ships per-asset SPCT portfolio snapshots with attestation timestamps via Chainlink PoR, rwa.xyz Enterprise Data API, or machine-parseable monthly audit PDFs.

---

## Out of Phase 4, possible future wave

Phase 6 of the 2026-04-16 remediation plan (large on-chain rewrites) was explicitly deferred. Each item is a multi-day engagement requiring a shared Multicall3 helper + per-adapter on-chain balance/position reads. Ship Phase 6 as its own plan once the first two land and inform priorities.

| Task | Coin(s) | Scope | Notes |
|---|---|---|---|
| **6.1 crvUSD on-chain rewrite** | `crvusd-curve` | L | Replace `prices.curve.finance` leg with direct LLAMMA `bands_y`/`bands_x` reads via Multicall3. Keeps the Yield Basis leg unchanged. Unblocks scoring-live for crvUSD. |
| **6.2 fxUSD on-chain** | `fxusd-f-x-protocol` | M | Direct f(x) pool-contract reads. |
| **6.3 ZCHF / DEURO on-chain** | `zchf-frankencoin`, `deuro-deuro` | L | On-chain position + collateral reads via Multicall3; multi-chain fan-out. |
| **6.4 wsrUSD cross-chain** | `wsrusd-reservoir` | L | Multi-chain balance fan-out against enumerated labeled addresses. |
| **6.5 IUSD on-chain** | `iusd-infinifi` | M | `infinifi-vault` ERC-4626 `totalAssets`/`totalSupply` direct reads. |
| **6.6 BtcUSD on-chain** | `btcusd-btcfi` | M | BTCfi handler contracts, `deposit_amount`/`borrow_amount` direct reads. |

Prerequisite shared work for Phase 6:
- New `worker/src/lib/evm-multicall.ts` helper wrapping Multicall3 `aggregate3` (canonical `0xcA11bde05977b3631167028862bE2a173976CA11` on every tracked EVM chain).
- Test harness + tsc clean criteria.

---

## Phase 4 adapter-swap deploy verification (Task 4.15)

Phase 4 swapped adapter kinds for several coins. Phase 1.4's cleanup
removes stale breaker-scope rows automatically on the next cron; this
section documents the post-deploy verification needed for each swap.

### Coins whose adapter kind changed in Phase 4

| Coin | Previous adapter | New adapter | Landed in |
|---|---|---|---|
| `buidl-blackrock` | `single-asset` | `chainlink-nav` | f8117d37 |
| `usdat-saturn` | (none) | `m0` | 21cf699f |
| `usdk-orki` | (none) | `liquity-v2-branches` | b78e3795 |
| `ebusd-ebisu` | (none) | `liquity-v2-branches` | 52545a64 (JSON content landed after b226f2c0 which contained Task 7.4 work under the ebUSD commit message) |

### Post-deploy verification

After the next deploy that includes these commits:

1. Confirm `reserve_sync_state.adapter_key` reflects the new adapter
   for each coin above (sample via `/api/stablecoin-reserves/<id>` or
   direct D1 query).
2. Confirm the live-reserves cron logs a successful fetch for each
   swapped coin within the first two runs.
3. Confirm no `single-asset`-scoped breaker rows persist for
   `buidl-blackrock` after the Phase 1.4 cleanup sweeps.
4. Spot-check the Pharos UI `/api/stablecoin-reserves/<id>` for each
   coin:
   - `buidl-blackrock` should now carry `evidenceClass=independent`
     with a fresh `oracleUpdatedAt`.
   - `usdat-saturn` should ride the existing M0 shared-source cache.
   - `usdk-orki` + `ebusd-ebisu` should emit branch-level slices with
     `freshnessMode=not-applicable`.

If any coin persistently fails after deploy, check the breaker state
first — stale breaker rows from the old adapter kind can suppress
writes until Phase 1.4 cleanup runs.

---

## Phase 4 skipped tasks (2026-04-16 session)

Documented here to avoid re-litigating the same feasibility work.

| Task | Coin | Reason skipped | Source checked |
|---|---|---|---|
| 4.8 | `pyusd-paypal` | No Chainlink PoR feed exists for PYUSD. Chainlink mainnet feed manifest lists only a `pyusd-usd` price feed (not PoR). | https://reference-data-directory.vercel.app/feeds-mainnet.json |
| 4.9 | `pusd-plume` | pUSD BoringVault (0xdddd73f5df1f0dc31373357beac77545dc5a6f3f) does not implement ERC-4626 (`asset()`, `totalAssets()`). Adapter reuse infeasible without new BoringVault-specific logic. | https://etherscan.io/address/0xdddd73f5df1f0dc31373357beac77545dc5a6f3f and https://docs.plume.org/plume/tokens/plume-usd |
| 4.11 | `usdtb-ethena` | Ethena `/api/positions/current/collateral` has no product/stablecoin discriminator (rows are `{asset, exchange, timestamp, usdAmount}`). chainlink-nav against BUIDL NAV would misrepresent USDtb's NAV (USDtb is USD-pegged, not a BUIDL NAV passthrough). Stays on `curated-validated`. Add to "Waiting on issuer" below. | https://app.ethena.fi/api/positions/current/collateral |
| 4.12 | `fpi-frax` | `/v2/fpi/balance-sheet/latest` does not exist in Frax's API (Swagger lists only `/frax/`, `/frxusd/`, `/sfrxusd/`, `/lfrax/` balance-sheet endpoints). The `/v2/fpifpis/fpi-collateral` endpoint has a different payload shape and would require adapter extension work out of scope here. | https://api.frax.finance/v2/docs/json |
| 4.13 | `cjpy-yamato` | Yamato is not ABI-compatible with Liquity v1. Yamato exposes `getStates()` returning `(totalColl, totalDebt, MCR, RRR, SRR, GRR)`, whereas liquity-v1 adapter hard-codes `getEntireSystemColl()` / `getEntireSystemDebt()`. Would need new adapter, not just config. | https://raw.githubusercontent.com/DeFiGeek-Community/yamato/master/contracts/Yamato.sol |

### Promotion blockers to add above

- **`usdtb-ethena`** — Waiting on issuer for USDtb-scoped reserve disclosure (product filter in Ethena collateral feed OR a USDtb-specific Anchorage/BUIDL holdings endpoint).
- **`fpi-frax`** — Waiting on issuer to restore the `/v2/fpi/balance-sheet/latest` endpoint, OR extend frax-balance-sheet adapter to accept the different `/v2/fpifpis/fpi-collateral` payload shape (adapter work).
- **`pusd-plume`** — Waiting on adapter-level change: BoringVault-specific reserve read (Nucleus Teller → underlying USDC via custom selector instead of ERC-4626 `totalAssets()`).
- **`cjpy-yamato`** — Waiting on adapter-level change: a Yamato-specific adapter reading `getStates()` on Yamato.sol + JPY/USD oracle to convert.

---

## Review log

- 2026-04-16: Tracker established per plan Task 7.3. Tasks 7.1 Path D follow-up and 7.2 USDz gate linked in.
- 2026-04-16: Task 5.2 mxnb-transparency adapter deferred — corrected coin id to `mxnb-juno` and refined gap note (aggregate MXN-vs-MXNB only, no per-asset breakdown).
- 2026-04-16: Task 4.15 — documented Phase 4 adapter swaps (buidl, usdat, usdk-orki, ebusd-ebisu) and skipped tasks (4.8, 4.9, 4.11, 4.12, 4.13) with concrete blockers.
