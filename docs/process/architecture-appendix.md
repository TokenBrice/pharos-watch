# Architecture — Data-Integrity Applications Appendix

The [architectural decisions](../architecture.md#adr-28) remain the authority for R1–R8. This appendix retains domain applications and implementation references; it grants no exceptions to those decisions.

## ADR-28 applications

- [DEX](../dex-liquidity.md#pool-quality-formula) preserves unavailable measured-balance and organic TVL weights across normalization, schemas, snapshots and views; ratios cannot supply aggregation weights, and observed zero remains distinct. [Status](../status-dashboard.md#overall-status) schema-admits coverage, retaining zero/false/nullable baselines; malformed telemetry is unavailable, never synthetic coverage.
- [Peg summary](../api-reference.md#get-apipeg-summary) preserves an empty live-deviation median as null, distinct from an observed parity median of zero; independent cohort and historical-event counts remain numeric.
- [Mint/burn](../mint-burn-flows.md#valuation-completeness) requires durable current-fingerprint scan proof per closed window before signed nets, direction, pressure or quiet-zero claims. Observed gross/count subtotals survive separately; missing proof is nullable with a machine reason across Pages, digest, DEWS, DDR and status.

## ADR-29 applications

- [DEX guards](../dex-liquidity.md#data-quality-filters) retain the accepted generation when required baseline reads fail; independently settled optional class/drift reads remain diagnostic. Nullable totals/classes and named failures survive metadata, status and rendering; successful empty bootstrap stays distinct. Deploy null-tolerant readers before nullable producers.
- [Tape](../tape-page.md#split-scan-determinism) carries usable warning baselines across corrupt observations; only valid producer-empty states clear them. Decoder reasons/bounded row evidence stay diagnostic.
- [Cron health](../status-dashboard.md#cron-health-model) keeps failed history summaries null with named reasons and independent lease/progress/slot outcomes. Admit progress clocks before establishing liveness or hiding terminal errors; retain rolling-deploy rules.
- Unavailable live peg deviations do not erase independently available historical analytics or imply that the historical event cohort is empty; the nullable median contract is owned by [API Reference](../api-reference.md#get-apipeg-summary).
- [Measured EVM proof admission](dex-liquidity-appendix.md#measured-evm-joining) distinguishes strict aggregate executed-member refusal from unavailable transport; the latter never proves CryptoSwap method absence.

## ADR-30 applications

- [Measured DEX history](dex-liquidity-appendix.md#curve-capture-and-measured-profiles) ages each constituent's original source quote at the consumer assessment clock; complete-cycle publication clocks cannot renew success/maturity evidence.
- [Safety pillar freshness](../report-cards.md#api) publishes scoring-time assessments with original source clock, generation, effective age budget and an explicit unknown reason. Publication age remains a separate consumer policy; retained bare-verdict publications remain historical verdicts, never synthetic assessments.
- [Inherited pricing](../pricing-pipeline.md#timestamp-semantics) retains the admitted parent's source clock; a fresh selection/write clock cannot rescue stale composite provenance, including supply NAV valuation.
- [Measured target valuation](dex-liquidity-appendix.md#measured-evm-joining) reassesses per-peg FX fallback at target capture using original source clocks and cadence; diagnostic stale references never certify score-bearing USD capacity.
- [Safety dependency evidence](report-cards-appendix.md#dependency-coverage) ages each live-derived graph from its asset's reserve fetch under the existing producer budget, not the cohort's newest fetch. Expired graphs retain edges with scoped stale producer proof rather than newly current evidence or an asset-wide build exception.

## ADR-32 applications

- Domain contracts: [addition checklist](adding-a-stablecoin.md), [cron health](../status-dashboard.md#cron-health-model), [reserve review](live-reserves-appendix.md), [DDR polling](../depeg-resolver.md#data-plumbing), [redemption polling](../redemption-backstops.md#frontend-consumers), [URL grades](../screener-page.md#url-contract). [DEWS attention](../depeg-page.md#metric-ownership) compares `THREAT_BAND_ORDER.ALERT`, never copied scores, while retaining active/pending incidents.
- Safety publication validators project peg adversity floors and research-age budgets from the policy JSON, not duplicated literals or another policy parse. Public responsibility summaries sort the canonical enum while fact tuple indices preserve its append-only order.

## ADR-33 applications

- Historical Tape methodology metadata names the persisted source version when available, otherwise its source-time registry epoch, not today's projector constant. Metadata repair preserves archive identity and never recomputes historical scores. [Tape pipeline](../tape-page.md#backing-pipeline) owns bounded correction.
- Reviewed evidence compares normalized observation and review clocks in every supported representation before hashing or binding; observation must not postdate review. Comparison does not rewrite original date strings or numeric clocks in the hashed envelope.
- [Measured profiles](dex-liquidity-appendix.md#curve-capture-and-measured-profiles) retain a mandatory canonical source hash alongside chain/number, with exact-hash reads and independent public provenance admission; old number-only evidence is not renewed.
- [FX source dates](worker-infrastructure-appendix.md#fx-and-metals-references) identify real observed calendar days, not future dates normalized to a local fetch time. Source-success TTL metadata belongs to the same admitted generation and never substitutes for an observation clock.
- Live reserve dependencies bind the consumed cohort generation and dependency payload while retaining the asset's original source and fetch clock. A sibling fetch can change cohort identity but cannot renew that asset's evidence.

## ADR-35 applications

- [Redemption](../redemption-backstops.md#cron-schedule) validates complete rows, persisted details and final dependency transforms before opening a run; invalid members become named failed placeholders and disclosures revalidate against that census. Global holds write no rows; post-manifest storage failure leaves an unreadable failed run. Supply repair/carry/quarantine remains solely [ADR-8(c)](../architecture.md#adr-8).
