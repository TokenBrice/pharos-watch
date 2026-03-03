# Road To NewID Migration Readiness Tasklist

Date: 2026-03-03 (updated 2026-03-04)  
Status: Living checklist (readiness only, no migration cutover in this document)  
Target: internal canonical stablecoin IDs in `ticker-name` format

## Scope

This checklist is for migration readiness work only:
- lock standards
- remove ambiguity and hidden coupling
- prepare safe cutover and rollback

Out of scope here:
- production cutover execution
- direct DB rewrite in production
- final redirect switch

## How To Use This Document

- Use this as a running backlog over multiple sessions.
- Keep each task as done or not done (`[x]` / `[ ]`).
- Keep notes and evidence links under each workstream as work progresses.
- Do not merge execution tasks into this file until readiness gates are green.
- See `newID-mission-statement.md` for Cloudflare D1 assumptions, rehearsal policy, and budget envelope.

## Readiness Gates

`R0` Discovery and standards complete:
- canonical format spec approved
- old->new mapping frozen v1
- known coupling inventory complete

`R1` Compatibility layer ready:
- provider IDs decoupled from internal IDs
- alias acceptance and redirects designed and tested
- URL state migration plan finalized

`R2` Migration mechanics ready:
- DB migration scripts dry-run and verified
- cache rebuild plan validated
- rollback playbook validated

`R3` Confidence ready:
- test suite updated and passing
- observability and alerting checks green
- docs and runbooks updated

`R4` Go/no-go ready:
- rehearsal completed end to end
- sign-off from product + engineering + ops

## Workstream Tracker

| Workstream | Status | Owner | Notes |
|---|---|---|---|
| WS0 Program Setup | Not started | TBD | |
| WS1 Canonical ID Standard | Not started | TBD | |
| WS2 Mapping And Aliases | Not started | TBD | |
| WS3 Provider Decoupling | Not started | TBD | |
| WS4 API And Routing Contracts | Not started | TBD | |
| WS5 Database And Persistence Prep | Not started | TBD | |
| WS6 Frontend URL State And UX Prep | Not started | TBD | |
| WS7 Worker Pipelines And Hardcoded Maps | Not started | TBD | |
| WS8 Caches, Static Data, And Artifacts | Not started | TBD | |
| WS9 Analytics, SEO, And Observability | Not started | TBD | |
| WS10 Tests And CI Guardrails | Not started | TBD | |
| WS11 Docs, Runbooks, And Team Enablement | Not started | TBD | |
| WS12 Dry-Runs, Rehearsals, And Sign-off | Not started | TBD | |

## WS0 Program Setup

- [ ] R00-001 [S] Define migration coordinator and backup coordinator.
- [ ] R00-002 [S] Define decision log file location for ID-policy decisions.
- [ ] R00-003 [S] Define branch strategy for readiness work.
- [ ] R00-004 [S] Define naming convention for readiness PRs.
- [ ] R00-005 [S] Define template for risks/issues/escalations.
- [ ] R00-006 [S] Define owner per workstream (engineering, product, ops).
- [ ] R00-007 [S] Define weekly checkpoint cadence.
- [ ] R00-008 [S] Define required sign-offs for gate progression (`R0`..`R4`).
- [ ] R00-009 [S] Define cutover freeze window policy.
- [ ] R00-010 [S] Define rollback authority and escalation chain.
- [ ] R00-011 [S] Capture current critical finding: DEWS blacklist map drift.
- [ ] R00-012 [S] Capture policy that this readiness track does not execute cutover.
- [ ] R00-013 [S] Lock Cloudflare plan assumptions for migration window (Workers Paid/Free, limits, retention).
- [ ] R00-014 [S] Add hard policy: no migration-affecting change merges to `main` without rehearsal evidence artifacts.
- [ ] R00-015 [S] Define minimum Wrangler version policy for operators and CI for Time Travel + D1 commands.
- [ ] R00-016 [S] Add source-of-truth doc links for D1 limits/pricing/time-travel/import-export.
- [ ] R00-017 [S] Define revalidation checkpoint for Cloudflare limits/pricing (latest check <= 7 days before cutover).
- [ ] R00-018 [S] Define who can execute `time-travel restore` and under what incident criteria.

## WS1 Canonical ID Standard

- [ ] R01-001 [M] Write formal canonical ID grammar for `ticker-name`.
- [ ] R01-002 [M] Define allowed character set and normalization rules.
- [ ] R01-003 [M] Define unicode transliteration policy.
- [ ] R01-004 [M] Define punctuation handling policy (`+`, `.`, `/`, `_`).
- [ ] R01-005 [M] Define case normalization policy (lowercase only).
- [ ] R01-006 [M] Define repeated hyphen collapse policy.
- [ ] R01-007 [M] Define max-length policy and truncation policy.
- [ ] R01-008 [M] Define reserved keywords blacklist (`global`, `all`, etc.).
- [ ] R01-009 [M] Define immutable-ID policy after publication.
- [ ] R01-010 [M] Define rename/rebrand policy using aliases not ID mutation.
- [ ] R01-011 [M] Define issuer-name token strategy (full name vs stable shortname).
- [ ] R01-012 [M] Define tie-break policy if future collisions occur.
- [ ] R01-013 [M] Define dead/shadow overlap identity policy.
- [ ] R01-014 [S] Define policy for IDs of defunct-only records.
- [ ] R01-015 [S] Define policy for synthetic/sentinel keys (`__global__`, `*`).
- [ ] R01-016 [S] Add canonical examples for top 30 coins.
- [ ] R01-017 [S] Add canonical examples for non-USD pegs.
- [ ] R01-018 [S] Add canonical examples for commodity pegs.
- [ ] R01-019 [S] Add canonical examples for shadow/defunct records.
- [ ] R01-020 [S] Approve standard and freeze as `ID_SPEC_V1`.

## WS2 Mapping And Aliases

- [ ] R02-001 [M] Generate deterministic old->new mapping for tracked coins.
- [ ] R02-002 [M] Generate deterministic old->new mapping for shadow coins.
- [ ] R02-003 [M] Propose mapping strategy for dead coins.
- [ ] R02-004 [M] Verify zero collisions in live set.
- [ ] R02-005 [M] Record known dead/shadow duplicate-entity collisions.
- [ ] R02-006 [M] Define canonical source-of-truth file path for mapping.
- [ ] R02-007 [M] Add schema for mapping object (oldId, newId, source, status).
- [ ] R02-008 [M] Add schema for alias object (alias, canonicalId, reason, ttl).
- [ ] R02-009 [M] Add versioning fields (`version`, `generatedAt`, `checksum`).
- [ ] R02-010 [M] Add checksum generation procedure for mapping integrity.
- [ ] R02-011 [S] Add review checklist for each mapped entry.
- [ ] R02-012 [S] Add manual overrides section for exceptional cases.
- [ ] R02-013 [S] Add policy for aliases that never expire.
- [ ] R02-014 [S] Add policy for aliases with sunset dates.
- [ ] R02-015 [S] Add policy for rejecting unknown legacy IDs.
- [ ] R02-016 [S] Add policy for provider-prefixed historical IDs.
- [ ] R02-017 [S] Define changelog format for mapping updates.
- [ ] R02-018 [S] Freeze `MAPPING_V1` with sign-off.
- [ ] R02-019 [S] Publish a human-readable mapping report for QA.
- [ ] R02-020 [S] Publish a machine-readable mapping artifact for scripts/tests.

## WS3 Provider Decoupling

- [ ] R03-001 [M] Define provider registry schema (`llamaId`, `geckoId`, `cmcSlug`, etc.).
- [ ] R03-002 [M] Ensure internal ID is never used directly as provider key.
- [ ] R03-003 [M] Design read helpers to fetch provider IDs by canonical ID.
- [ ] R03-004 [M] Inventory all DefiLlama endpoint calls using internal ID.
- [ ] R03-005 [M] Inventory all CoinGecko endpoint calls relying on internal ID assumptions.
- [ ] R03-006 [M] Inventory all Bluechip and external slug lookups.
- [ ] R03-007 [M] Document fallback behavior when provider IDs are missing.
- [ ] R03-008 [M] Define behavior for coins not supported by a provider.
- [ ] R03-009 [M] Add validation rules for provider registry completeness.
- [ ] R03-010 [S] Define policy for provider ID changes over time.
- [ ] R03-011 [S] Define policy for provider ID deprecations.
- [ ] R03-012 [S] Define policy for multi-provider mismatch alerts.
- [ ] R03-013 [S] Add operational runbook for provider-registry hotfixes.
- [ ] R03-014 [S] Add test plan for provider-decoupled requests.
- [ ] R03-015 [S] Approve provider registry contract.

## WS4 API And Routing Contracts

- [ ] R04-001 [M] Define accepted ID formats during transition window.
- [ ] R04-002 [M] Define alias-resolution order (canonical, alias, reject).
- [ ] R04-003 [M] Define API error semantics for unknown/legacy IDs.
- [ ] R04-004 [M] Design read-time normalization middleware for API queries.
- [ ] R04-005 [M] Design route-level normalization for `/stablecoin/:id`.
- [ ] R04-006 [M] Design canonical URL redirect policy (301 vs 302 per phase).
- [ ] R04-007 [M] Define redirect behavior for malformed IDs.
- [ ] R04-008 [M] Define query-param normalization (`stablecoin=` endpoints).
- [ ] R04-009 [M] Define compatibility window length and sunset criteria.
- [ ] R04-010 [M] Define telemetry for alias-hit frequency.
- [ ] R04-011 [S] Define contract for admin backfill endpoints during transition.
- [ ] R04-012 [S] Define contract for status/debug endpoints during transition.
- [ ] R04-013 [S] Document backward compatibility matrix by endpoint.
- [ ] R04-014 [S] Document route compatibility matrix for frontend links.
- [ ] R04-015 [S] Add deprecation headers strategy (if used).
- [ ] R04-016 [S] Approve API/route compatibility spec.

## WS5 Database And Persistence Prep

- [ ] R05-001 [M] Inventory all D1 tables with `stablecoin_id` fields.
- [ ] R05-002 [M] Inventory symbol-based legacy tables (`stablecoin` symbol columns).
- [ ] R05-003 [M] Inventory JSON blobs storing IDs (`daily_digest.input_data` etc.).
- [ ] R05-004 [M] Define SQL migration order by dependency.
- [ ] R05-005 [M] Define chunking strategy and transaction boundaries.
- [ ] R05-006 [M] Define idempotent migration script contract.
- [ ] R05-007 [M] Define pre-migration row-count baselines by table.
- [ ] R05-008 [M] Define post-migration row-count invariants by table.
- [ ] R05-009 [M] Define referential-consistency checks across tables.
- [ ] R05-010 [M] Define duplicate-key conflict checks after remap.
- [ ] R05-011 [M] Define handling for sentinel keys (`__global__`, `*`) exclusion.
- [ ] R05-012 [M] Define handling for rows with unknown IDs.
- [ ] R05-013 [M] Define handling for dead/shadow ID overlaps.
- [ ] R05-014 [M] Define strategy for historical blob remap vs read-time alias.
- [ ] R05-015 [M] Define rollback SQL script strategy.
- [ ] R05-016 [M] Define backup and restore rehearsal steps for D1 snapshots.
- [ ] R05-017 [S] Define DB clone naming convention for rehearsals.
- [ ] R05-018 [S] Define migration report artifact format.
- [ ] R05-019 [S] Define post-migration vacuum/index maintenance plan.
- [ ] R05-020 [S] Define operational lock and concurrency considerations.
- [ ] R05-021 [S] Dry-run migration on clone: pass 1.
- [ ] R05-022 [S] Dry-run migration on clone: pass 2 reproducibility.
- [ ] R05-023 [S] Validate rollback on clone.
- [ ] R05-024 [S] Sign off `DB_MIGRATION_READY`.
- [ ] R05-025 [M] Verify `stablecoin-db` backend version is production (`wrangler d1 info`) and record evidence.
- [ ] R05-026 [M] Define dedicated rehearsal DB naming convention (`stablecoin-db-newid-rehearsal-*`) and lifecycle policy.
- [ ] R05-027 [M] Define environment binding strategy in Wrangler (`production` vs `staging/rehearsal` D1 IDs).
- [ ] R05-028 [M] Define export scheduling policy acknowledging that remote export can block DB requests.
- [ ] R05-029 [M] Define prod->rehearsal copy pipeline (`d1 export --remote` + import into rehearsal DB).
- [ ] R05-030 [M] Define split-file strategy if SQL export/import chunk exceeds 5GB file limit.
- [ ] R05-031 [M] Define SQL shaping strategy for D1 limits (100KB statement, 100 parameters, 30s query duration).
- [ ] R05-032 [M] Define rehearsal data fidelity rule (full dataset vs sampled subsets by table and rationale).
- [ ] R05-033 [M] Define migration execution matrix: `--local`, `--preview`, `--remote` and expected outcomes.
- [ ] R05-034 [M] Define pre-migration Time Travel bookmark capture procedure and evidence format.
- [ ] R05-035 [M] Define restore rehearsal using `wrangler d1 time-travel restore` on rehearsal DB (bookmark/timestamp based).
- [ ] R05-036 [M] Define post-restore validation checklist (row counts, checksums, critical API parity).
- [ ] R05-037 [S] Define D1 cost-observability checklist for rehearsal (rows_read/rows_written spikes, storage growth).
- [ ] R05-038 [S] Define fallback for export blockers (R2 archival via Workflows for longer-retention snapshots if needed).
- [ ] R05-039 [S] Define limit-increase request trigger thresholds (DB count/storage ceilings) and owner.
- [ ] R05-040 [S] Sign off `D1_REHEARSAL_LANE_READY`.

## WS6 Frontend URL State And UX Prep

- [ ] R06-001 [M] Decide canonical URL-state format for compare (`coins=` IDs only).
- [ ] R06-002 [M] Decide canonical URL-state format for portfolio (`p=` IDs or structured payload).
- [ ] R06-003 [M] Decide canonical URL-state format for stress-test (`stress=` ID).
- [ ] R06-004 [M] Define parser behavior for mixed legacy + canonical query state.
- [ ] R06-005 [M] Define writer behavior to always emit canonical IDs.
- [ ] R06-006 [M] Define UX handling for legacy shared links.
- [ ] R06-007 [M] Define compatibility handling for preset symbol shortcuts.
- [ ] R06-008 [M] Define migration policy for localStorage portfolio data.
- [ ] R06-009 [M] Define migration policy for bookmarked URLs.
- [ ] R06-010 [S] Define canonical link behavior in stablecoin detail compare CTA.
- [ ] R06-011 [S] Define command palette search/display unaffected by ID changes.
- [ ] R06-012 [S] Define UI observability event for legacy-link normalization.
- [ ] R06-013 [S] Define QA matrix for deep-links and back/forward navigation.
- [ ] R06-014 [S] Define browser compatibility checklist for query migration.
- [ ] R06-015 [S] Sign off `FRONTEND_URL_READY`.

## WS7 Worker Pipelines And Hardcoded Maps

- [ ] R07-001 [M] Build exhaustive hardcoded-map inventory with owners.
- [ ] R07-002 [M] Define replacement strategy per map (rekey vs computed lookup).
- [ ] R07-003 [M] Define static validation for map keys against registry.
- [ ] R07-004 [M] Define runtime guard for unknown map keys.
- [ ] R07-005 [M] Define fallback behavior when map key missing.
- [ ] R07-006 [M] Prepare DEWS blacklist map correction plan.
- [ ] R07-007 [M] Prepare mint/burn contract map rekey plan.
- [ ] R07-008 [M] Prepare yield-config map rekey plan.
- [ ] R07-009 [M] Prepare bluechip slug map rekey plan.
- [ ] R07-010 [M] Prepare backfill overrides map rekey plan.
- [ ] R07-011 [M] Prepare sync-stablecoins address override rekey plan.
- [ ] R07-012 [M] Prepare commodity/other currency exception map rekey plan.
- [ ] R07-013 [M] Define acceptance tests for each critical map.
- [ ] R07-014 [S] Define linter/check to forbid new numeric ID literals in map keys.
- [ ] R07-015 [S] Define linter/check to flag stale map entries.
- [ ] R07-016 [S] Define map-source centralization strategy.
- [ ] R07-017 [S] Define emergency map hotfix runbook.
- [ ] R07-018 [S] Sign off `PIPELINES_MAP_READY`.

## WS8 Caches, Static Data, And Artifacts

- [ ] R08-001 [M] Inventory ID-keyed cache entries in worker (`detail:${id}`, maps).
- [ ] R08-002 [M] Inventory ID-keyed frontend artifacts (`logos`, `ai-summaries`).
- [ ] R08-003 [M] Define cache key migration strategy (dual-write, invalidate, rebuild).
- [ ] R08-004 [M] Define stale-cache protection during mixed-ID window.
- [ ] R08-005 [M] Define static artifact rekey process and verification.
- [ ] R08-006 [M] Define compatibility lookup for old artifact keys during transition.
- [ ] R08-007 [M] Define digest artifact handling if IDs appear in stored payloads.
- [ ] R08-008 [S] Define cache warm-up sequence after migration.
- [ ] R08-009 [S] Define rollback cache invalidation sequence.
- [ ] R08-010 [S] Define cache-level health checks before/after cutover.
- [ ] R08-011 [S] Sign off `CACHE_ARTIFACT_READY`.

## WS9 Analytics, SEO, And Observability

- [ ] R09-001 [M] Define analytics ID continuity strategy (`coin_id`, `coin_ids`).
- [ ] R09-002 [M] Define BI remap plan for historical dashboards.
- [ ] R09-003 [M] Define telemetry for legacy-ID API usage.
- [ ] R09-004 [M] Define telemetry for redirect hit-rates.
- [ ] R09-005 [M] Define telemetry for alias normalization hit-rates.
- [ ] R09-006 [M] Define SEO redirect map for all old detail URLs.
- [ ] R09-007 [M] Define canonical URL policy post-migration.
- [ ] R09-008 [M] Define sitemap and JSON-LD validation checklist.
- [ ] R09-009 [M] Define link-check job for internal route references.
- [ ] R09-010 [M] Define status endpoint checks for ID-join consistency.
- [ ] R09-011 [S] Define alert thresholds for 4xx spikes after alias sunset.
- [ ] R09-012 [S] Define alert thresholds for data divergence post-remap.
- [ ] R09-013 [S] Define monitoring dashboard diff view (before/after).
- [ ] R09-014 [S] Sign off `ANALYTICS_SEO_OBSERVABILITY_READY`.
- [ ] R09-015 [M] Add D1 row-metrics dashboard for rehearsal/cutover windows (`rows_read`, `rows_written`, storage).
- [ ] R09-016 [M] Add alert thresholds for D1 limit pressure (storage, row-volume anomalies, query errors).
- [ ] R09-017 [S] Add D1 Time Travel restore event logging/auditing checklist.
- [ ] R09-018 [S] Add optional read-replication telemetry plan (`served_by_region`, `served_by_primary`) if Sessions API is used.

## WS10 Tests And CI Guardrails

- [ ] R10-001 [M] Inventory tests using numeric IDs directly.
- [ ] R10-002 [M] Define fixture migration strategy for IDs.
- [ ] R10-003 [M] Add test helper for canonical ID generation/validation.
- [ ] R10-004 [M] Add test helper for alias resolution.
- [ ] R10-005 [M] Add regression tests for known symbol collisions.
- [ ] R10-006 [M] Add regression test for DEWS blacklist mapping correctness.
- [ ] R10-007 [M] Add API contract tests for legacy + canonical ID acceptance window.
- [ ] R10-008 [M] Add redirect tests for old route forms.
- [ ] R10-009 [M] Add DB migration dry-run assertion tests.
- [ ] R10-010 [M] Add post-migration data parity tests.
- [ ] R10-011 [S] Add CI check to block new numeric-ID literals in key maps.
- [ ] R10-012 [S] Add CI check to block symbol-encoded identity URLs in core flows.
- [ ] R10-013 [S] Add CI check to ensure mapping artifact and registry are in sync.
- [ ] R10-014 [S] Add CI check to ensure no unknown IDs in tracked datasets.
- [ ] R10-015 [S] Sign off `TESTS_CI_READY`.

## WS11 Docs, Runbooks, And Team Enablement

- [ ] R11-001 [M] Update API reference to canonical ID model.
- [ ] R11-002 [M] Update adding-a-stablecoin process to canonical ID model.
- [ ] R11-003 [M] Update supply/backfill runbooks for provider decoupling model.
- [ ] R11-004 [M] Update scripts docs to remove numeric-first assumptions.
- [ ] R11-005 [M] Add explicit “internal ID vs provider ID” section in docs.
- [ ] R11-006 [M] Add “how to add aliases safely” runbook.
- [ ] R11-007 [M] Add “how to verify map integrity” runbook.
- [ ] R11-008 [S] Add operator checklist for pre-cutover day.
- [ ] R11-009 [S] Add operator checklist for cutover day.
- [ ] R11-010 [S] Add operator checklist for post-cutover week.
- [ ] R11-011 [S] Add incident response playbook for ID resolution failures.
- [ ] R11-012 [S] Add FAQ for product/support on changed URLs and IDs.
- [ ] R11-013 [S] Sign off `DOCS_RUNBOOKS_READY`.

## WS12 Dry-Runs, Rehearsals, And Sign-off

- [ ] R12-001 [M] Build full rehearsal checklist with timestamps.
- [ ] R12-002 [M] Rehearse alias-enabled API behavior on staging.
- [ ] R12-003 [M] Rehearse route redirect behavior on staging.
- [ ] R12-004 [M] Rehearse URL-state normalization on staging.
- [ ] R12-005 [M] Rehearse DB migration on fresh clone with full dataset.
- [ ] R12-006 [M] Rehearse cache invalidation and warm-up sequence.
- [ ] R12-007 [M] Rehearse rollback script on clone and validate parity.
- [ ] R12-008 [M] Rehearse observability dashboard checks and alerts.
- [ ] R12-009 [M] Rehearse SEO checks (sitemap, canonical, redirects).
- [ ] R12-010 [M] Rehearse analytics continuity checks.
- [ ] R12-011 [M] Rehearse smoke tests for critical pages and APIs.
- [ ] R12-012 [S] Produce rehearsal report v1 with findings.
- [ ] R12-013 [S] Fix rehearsal findings and rerun targeted drills.
- [ ] R12-014 [S] Produce rehearsal report v2 (clean run).
- [ ] R12-015 [S] Collect final go/no-go sign-offs for `R4`.
- [ ] R12-016 [M] Rehearse prod-like export/import copy flow duration and document expected lock/block window.
- [ ] R12-017 [M] Rehearse D1 migration apply on rehearsal DB through exact CI command path.
- [ ] R12-018 [M] Rehearse Time Travel restore on rehearsal DB to pre-migration bookmark.
- [ ] R12-019 [M] Validate post-restore API/data parity after rehearsal restore.
- [ ] R12-020 [S] Rehearse two consecutive migration passes on fresh rehearsal copies for determinism.
- [ ] R12-021 [S] Rehearse failure injection (mid-migration error) and verify rollback + operator playbook.
- [ ] R12-022 [S] Rehearse cutover-day comms timeline including export window notice and restore escalation path.
- [ ] R12-023 [S] Attach all D1 rehearsal evidence artifacts to go/no-go packet.

## Critical Readiness Risks To Track

- [ ] RR-001 Alias layer incomplete, legacy traffic still high.
- [ ] RR-002 Symbol-based URL state not fully migrated.
- [ ] RR-003 Hidden hardcoded ID maps missed.
- [ ] RR-004 Provider-decoupling incomplete, upstream fetches break.
- [ ] RR-005 DB remap and cache rebuild sequencing mismatch.
- [ ] RR-006 SEO redirect coverage incomplete.
- [ ] RR-007 Analytics continuity not validated.
- [ ] RR-008 Defunct/shadow identity policy unresolved.
- [ ] RR-009 No dedicated DB rehearsal lane; first full migration run would effectively be prod.
- [ ] RR-010 Export window underestimated; DB request blocking causes production latency/errors.
- [ ] RR-011 D1 plan/limits assumptions stale at cutover time.
- [ ] RR-012 Restore path unproven under realistic load/timeline pressure.

## Suggested Session Slices

Use these as compact session goals:

- [ ] Session Slice A: WS1 + WS2 draft complete (`ID_SPEC_V1`, `MAPPING_V1` draft).
- [ ] Session Slice B: WS3 + WS4 contracts drafted and reviewed.
- [ ] Session Slice C: WS5 migration mechanics and verification specs drafted.
- [ ] Session Slice D: WS6 + WS7 implementation-prep checklist refined.
- [ ] Session Slice E: WS8 + WS9 observability/SEO/analytics readiness refined.
- [ ] Session Slice F: WS10 + WS11 guardrails/docs ready for execution phase.
- [ ] Session Slice G: WS12 rehearsal plan finalized.

## Session Log

### 2026-03-03

- Created readiness checklist baseline.
- Added workstreams, task IDs, and readiness gates.
- Seeded known critical risk: DEWS map drift and symbol URL ambiguity.

### 2026-03-04

- Added Cloudflare D1 baseline assumptions (limits, Time Travel, export/import constraints, pricing-aware notes).
- Expanded WS0/WS5/WS9/WS12 with explicit D1 rehearsal-lane tasks and evidence requirements.
- Added D1-specific critical risks (export blocking, stale limits assumptions, unproven restore path).
- Moved narrative baseline/cost content to `newID-mission-statement.md` to keep this file task-only.
