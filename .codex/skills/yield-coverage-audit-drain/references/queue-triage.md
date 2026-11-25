# Yield Coverage Queue Triage

Load only when the snapshot has queue items or due reviews. The kind column mirrors `YieldCoverageAuditQueueItemKind` in `shared/types/status/yield-liquidity.ts`; the source file wins, and a kind not listed here is triaged from its emitter in `worker/src/cron/yield-coverage-audit/detectors.ts`.

## Triage By Kind

| Kind or surface | Decide |
| --- | --- |
| `stale-auto-lending-override` on an auto-lending pin | Verify the mapped DeFiLlama pool still exists, is single-exposure, stablecoin-marked, in an allowlisted project, above the APY and TVL floors, and not collision-blocked. Remove the pin or repoint it to a verified replacement. |
| `stale-auto-lending-override` with reason `missing-pool` | A dead curated pin in `YIELD_POOL_MAP`, `YIELD_VARIANT_MAP` or `YIELD_WEIGHTED_POOL_GROUPS`. `coverage-outage` means the asset publishes no ranking row: treat it as an incident under [Yield Health remediation](../../../../docs/runbooks/yield-health.md#remediation). `dead-config` means it still publishes through another source: clean up the pin. A pin left on an asset delisted under the [listing policy](../../../../docs/listing-policy.md#lifecycle-policy) is cleanup, not an outage. |
| `native-exact-pool` | Verify the tracked stablecoin by chain and address, or a documented wrapper variant. Promote only exact native holder-yield rows. |
| `lending-allowlist` | Verify the DeFiLlama protocol category against `HIGH_CONFIDENCE_PROTOCOL_CATEGORIES` in the detectors file. Add slugs only from the queue or a clearly equivalent candidate. |
| `source-family-adapter` | Check [Reviewed source-family boundaries](../../../../docs/yield-intelligence-operations.md#reviewed-source-family-boundaries) first. Require a reusable protocol-native API or on-chain adapter shape; no one-off scrapers. |
| `unmatched-high-tvl-pool`, `missing-protocol` | Decide venue map, allowlist or adapter candidacy, or record a documented intentional gap. Watch severity is not a reason to leave the row unaddressed. |
| `venue-risk-config-missing` | Author a reviewed `YIELD_RISK_CONFIG` entry from source evidence; never guess sub-scores. |
| `stale-venue-risk-score` | Re-review the venue. `findStaleVenueRiskScores` covers both `YIELD_RISK_CONFIG` and `YIELD_DEPENDENCY_CONCENTRATION`; refresh sub-scores and `reviewedAt` together. Run `npm run calibrate:yield-venue-risk` when recalibrating. |
| `manifest-missing`, `ranking-missing` | Classify as source gap, publication gate, safety gate, stale benchmark or intentional gap before touching config. |
| `quarantine-ready-to-restore` (historical) | Follow [retired-reader boundaries](../../../../docs/yield-intelligence.md#tier-1-on-chain-reads) and the remediation runbook before interpreting retained items. |
| `reviewDueAdapters` | Classify every due `YIELD_ADAPTER_LIFECYCLE` review in this cycle per [Adapter lifecycle states](../../../../docs/yield-intelligence-operations.md#adapter-lifecycle-states): update the typed reason note and move `nextReviewAt`. No past-due date survives a drain. |
| Exclusions | Re-review entries in `YIELD_OPPORTUNITY_EXCLUSIONS` that are due per [Dated opportunity exclusions](../../../../docs/yield-intelligence-operations.md#dated-opportunity-exclusions); an active hold suppresses gap detection for its scope. |

Retired protocol-native sources are owned by [Tier 2.5](../../../../docs/yield-intelligence.md#tier-25-protocol-native-yield-apis); do not re-add one from a queue row.

## Verify Source Identity

1. Pull live DeFiLlama Yields data from `https://yields.llama.fi/pools` or the candidate's chart endpoint.
2. Match the candidate to local stablecoin metadata by contract address, wrapper mapping, chain alias and symbol. A symbol-only match is acceptable only when address data is unavailable and no same-symbol collision exists.
3. Use existing Pharos chain IDs from `shared/types/chain-identity.ts`; never invent a chain identifier.
4. When a live pool is valid but belongs to a different tracked asset, add a guard to `AUTO_LENDING_COLLISION_BLOCKLIST`.
5. A safety-bypass candidate needs a code comment saying why the bypass is limited and why that exact pool is acceptable.
6. Reviewing or adding an on-chain reader follows [Pinned On-Chain Evidence](../../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence).

## Authored Config Targets

Edit the authored source, never a derived export.

| Change | Authored in | Derived, do not edit |
| --- | --- | --- |
| Exact yield-bearing pool | `YIELD_POOL_MAP` and `YIELD_POOL_RESTRICTED_REWARD_IDS` in `worker/src/lib/yield-config/yield-config-pools.ts`; variants and weighted groups in the sibling `yield-config-variants.ts` and `yield-config-weighted-pools.ts` | |
| Pinned venue opportunity, with its `bypassSafety` flag | `AUTO_LENDING_OVERRIDES` in `shared/lib/yield-auto-lending.ts`, only when the pinned UUID is safer than generic discovery | `AUTO_LENDING_POOL_MAP` |
| Reusable lending protocol | `LENDING_PROTOCOLS` in `worker/src/lib/yield-config/yield-config-lending-venues.ts` | `LENDING_PROTOCOL_ALLOWLIST`, `LENDING_PROTOCOL_LABELS` in `yield-config-lending-protocols.ts` |
| Collision guard | `AUTO_LENDING_COLLISION_BLOCKLIST` in `worker/src/lib/yield-config/yield-config-lending-protocols.ts` | |
| Venue risk | `YIELD_RISK_CONFIG` or `YIELD_DEPENDENCY_CONCENTRATION` in `shared/lib/yield-source-risk-registry.ts`, with the matching key in `shared/data/yield-source-risk-evidence.json` in the same change (the registry test enforces key lockstep) | |
| Adapter lifecycle | `YIELD_ADAPTER_LIFECYCLE` in `worker/src/lib/yield-config/yield-config-rate-sources.ts` | Legacy string map |
| Dated hold | `YIELD_OPPORTUNITY_EXCLUSIONS` in `worker/src/lib/yield-config/yield-opportunity-exclusions.ts` | |
| Benchmark-derived asset | Benchmark fetcher, cache schema, benchmark type, rate-derived config, tests, and the docs source roster | |

## Reject Or Defer

Promote only when identity, source, APY/TVL and publication gates all pass. Reject or defer when:

- The pool is multi-exposure, below floor, reward-only with no base yield, or same-symbol but the wrong asset.
- The product page shows an APY but exposes no stable public machine-readable endpoint.
- The source is gated by login or session headers, legal accreditation, or undisclosed off-chain reporting.
- A native module exists without a verified adapter path: record the candidate and a next review date instead of speculative code.

Every deferral names the condition or date that reopens it.
