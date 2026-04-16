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
| `mxnb-bitso` | weak-live-probe | Insufficient transparency-data granularity in the current transparency feed (Task 5.2 deferred). |
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

Not in the Phase 7 scope today, but adjacent to the Phase 6 on-chain rewrites.

| Coin | Direction |
|---|---|
| `zchf-frankencoin` | On-chain rewrite of the reserve feed when Phase 6 expands. |
| `deuro-deuro` | On-chain rewrite when Phase 6 expands. |
| `wsrusd-war-sky-road` | On-chain rewrite when Phase 6 expands. |
| `iusd-infinifi` | On-chain rewrite when Phase 6 expands. |
| `btcusd-btcfi` | Phase 6.6 scope — handler-contract direct reads. |
| `fxusd-f-x-protocol` | On-chain rewrite when Phase 6 expands. |

---

## Review log

- 2026-04-16: Tracker established per plan Task 7.3. Tasks 7.1 Path D follow-up and 7.2 USDz gate linked in.
