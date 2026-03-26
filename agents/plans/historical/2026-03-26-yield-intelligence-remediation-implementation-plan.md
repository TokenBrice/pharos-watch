# 2026-03-26 Yield Intelligence Remediation Implementation Plan

> Execution plan for [2026-03-26-yield-intelligence-comprehensive-audit.md](../audits/2026-03-26-yield-intelligence-comprehensive-audit.md).
> This plan folds in still-relevant themes from earlier historical yield plans, but is scoped to the live findings and structural issues confirmed in the 2026-03-26 audit.

## Objective

Remediate the yield intelligence module so that:

1. yield source attribution is materially correct even in the presence of duplicate symbols and multi-chain ambiguity
2. every yield-bearing asset has explicit, auditable coverage semantics
3. publication, warnings, provenance, and source links tell a coherent story
4. adapter expansion stops increasing maintenance cost linearly
5. deploy validation becomes yield-aware and blocks regressions before push and before prod rollout

## Non-Negotiable Constraints

- Keep changes root-cause driven. No “just suppress this one case” patches unless they come with an explicit retirement path.
- Do not expand adapter breadth on top of the current symbol-only identity model.
- Any methodology-affecting change must update:
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-timeline.md`
  - `src/app/methodology/methodology-sections.tsx`
  - `shared/lib/yield-methodology-version.ts` if methodology versioning is already used for the changed surface
- Any API contract or provenance shape change must update:
  - `docs/api-reference.md`
  - shared runtime types/schemas
  - the matching worker/frontend consumers
- Any genuinely new external data source must update:
  - source documentation
  - `docs/about-page.md`
- Before any push in the implementation phase:
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - `cd worker && npx tsc --noEmit`
  - `npm run test:merge-gate`

## Findings Covered

This plan covers all findings from the 2026-03-26 audit:

- Critical:
  1. live symbol-collision misattribution
- High:
  2. weak coverage regression guard
  3. variant metadata not enforced at runtime
  4. protocol-native symbol-only resolution
  5. invalid Aave `yieldType`
  6. manifest and coverage audit are not a source of truth
- Medium:
  7. warning median mismatch
  8. non-atomic publication leaves read surfaces out of sync
  9. inconsistent source keys
- Adapter-specific:
  - BIMA quality gating
  - Hashnote order dependence
  - Ondo short-anchor methodology
  - Morpho/Pendle/Yearn/Kong/Beefy/Compound/Aave identity and provenance issues
  - source-link prefix failures
  - fragile or missing coverage for `usbd-bima`, `usg-tangent`, `ftusd-flying-tulip`, `cetes-etherfuse`, `dusd-dtrinity`, `usdh-hermetica`
- Maintainability:
  - hotspot files
  - fragmented registry/configuration
  - unused code
  - duplicated provenance logic
  - lack of invariant and live-coverage tests

## Delivery Strategy

Do not ship this as one large branch or one large PR. The work has ordering dependencies:

1. identity correctness first
2. coverage truth second
3. adapter-level fixes and gap closure third
4. publication and warning consistency fourth
5. codebase simplification after behavior stabilizes
6. docs, tests, rollout gates, and smoke coverage in parallel but blocking before push

Recommended PR stack:

1. identity/matching blockers
2. coverage truth model + invariants
3. protocol-native adapter identity fixes
4. direct adapter quality fixes + gap closure
5. publication/provenance/source-link consistency
6. structural refactor + dead-code cleanup
7. docs and rollout hardening if not already fully landed by previous PRs

## Workstream Map

| Workstream | Priority | Main problems closed |
| --- | --- | --- |
| W0. Ground Truth And Safety Harness | P0 | Establishes invariants and canaries before touching resolver logic |
| W1. Identity And Matching Hardening | P0 | Findings 1, 3, 4, 9 |
| W2. Coverage Truth Model And Guardrails | P0 | Findings 2, 6 and missing-coverage blind spots |
| W3. Adapter-Specific Corrections And Gap Closure | P0/P1 | All adapter-specific audit findings and missing live coverage |
| W4. Publication, Provenance, Warning, And Link Consistency | P0/P1 | Findings 5, 7, 8, 9 and source-link issues |
| W5. Structural Refactor And LOC Reduction | P1 | hotspot reduction, duplicate logic, dead code, type safety |
| W6. Validation, Rollout, And Documentation | P0 | blocks regressions and formalizes ship criteria |

## W0 - Ground Truth And Safety Harness

### Goal

Create the tests, fixtures, and canary set needed to safely change source identity and coverage rules.

### Why This Comes First

The riskiest fixes in this plan will intentionally change which rows resolve and which rows are dropped. That work needs explicit fixtures for duplicate symbols and missing coverage before the resolver is touched.

### Implementation

1. Add a canonical duplicate-symbol fixture set used across resolver tests.
   - Include at minimum:
     - `CUSD`
     - `REUSD`
     - `USDM`
     - `PUSD`
     - `USDA`
     - `USDF`
     - `MSUSD`
     - `USDP`
2. Add a canary asset set for validation and rollout.
   - Collision canaries:
     - `cusd-cap`
     - `reusd-re-protocol`
     - `usdm-moneta`
     - `pusd-polaris`
   - Direct-adapter canaries:
     - `usyc-hashnote`
     - `usdy-ondo-finance`
     - `usbd-bima`
   - Deterministic canaries:
     - `usde-ethena`
     - `ustb-superstate`
   - Fallback canaries:
     - `buidl-blackrock`
     - `cetes-etherfuse`
3. Add a test helper that can build a mini tracked-stablecoin universe with:
   - duplicate symbols
   - chain overlap
   - address overlap/no overlap
   - explicit override pools
4. Add a test fixture for “yield-bearing but missing from live rankings” so the new coverage checks have a stable target.

### Acceptance Criteria

- Duplicate-symbol scenarios can be tested without depending on live data.
- Every later workstream can prove behavior against the same fixtures and canaries.

### Validation

- New test helper is used by:
  - `yield-helpers.test.ts`
  - `yield-resolve.test.ts`
  - `sync-yield-data.test.ts`

## W1 - Identity And Matching Hardening

### Goal

Replace symbol-driven matching with address-first, chain-aware, ambiguity-aware matching across all yield-resolution lanes.

### Problems Closed

- Finding 1 directly
- Finding 3 directly
- Finding 4 directly
- Finding 9 partially

### Main Surfaces

- `worker/src/cron/yield-helpers.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-sync/sources.ts`
- new identity helper module, likely one of:
  - `worker/src/cron/yield-sync/identity.ts`
  - or a shared worker identity helper reused from the DEX-liquidity side

### Implementation

1. Introduce a canonical yield-identity model.
   - Each candidate row should carry as much identity as the upstream can provide:
     - base asset address
     - base asset chain
     - wrapper address
     - wrapper chain
     - protocol source address
     - symbol only as a fallback, never as the preferred identity
2. Build shared stablecoin lookup indexes once per run.
   - By normalized id
   - By normalized symbol
   - By normalized `(chain, address)`
   - By normalized `(chain, symbol)` for last-resort uniqueness checks
3. Replace the local `PHAROS_TO_DL_CHAIN` map in yield with a shared mapping utility.
   - Reuse the stronger chain-aware identity patterns already present in the DEX-liquidity area where possible.
   - The mapping must cover the ecosystems currently implicated by live misattribution, at minimum:
     - `celo`
     - `plume`
     - `sonic`
     - `hyperevm`
     - `megaeth`
     - `monad`
4. Rework `findBestLendingPool()`.
   - Address match must outrank symbol match whenever the coin has known contract addresses.
   - Symbol-only should only be allowed when the candidate set is unique after chain scoping.
   - If symbol remains ambiguous after chain scoping, return `null` and log an ambiguity event instead of guessing.
   - Explicit override pools must be reserved so they cannot later be dynamically attached to a different coin.
5. Rework `matchAllDlPools()`.
   - Variant matching must use `variantChain` and `variantAddress` when present.
   - Base-symbol `.includes()` fallback should become:
     - lower confidence
     - chain scoped
     - ambiguity aware
     - logged when used
6. Change protocol-native resolver integration.
   - Adapters should return richer identity objects, not just `{ symbol, yield }`.
   - Resolver should match:
     1. by `(chain, address)` if available
     2. by unique `(chain, symbol)` if address is unavailable
     3. by global symbol only if unique across tracked set
   - If no unambiguous match exists, the row should be dropped and counted as an ambiguous upstream candidate.
7. Normalize source identity.
   - Use full addresses or UUIDs, not truncated substrings.
   - Include chain where the same protocol can surface the same asset on multiple chains.

### Acceptance Criteria

- Duplicate-symbol assets no longer share the same discovered source unless that is intentionally the same economic source for the same coin.
- The live misattribution cases from the audit are all closed by test coverage.
- Resolver chooses “no row” over a guessed row when identity remains ambiguous.

### Validation

Add tests for:

- address beats symbol in `findBestLendingPool()`
- symbol-only path returns `null` on ambiguity
- explicit override pool is not reusable by dynamic discovery
- `matchAllDlPools()` uses `variantChain` and `variantAddress`
- protocol-native resolvers drop ambiguous rows instead of attaching them to the first symbol match

Run at minimum:

```bash
npx vitest run worker/src/cron/__tests__/yield-helpers.test.ts worker/src/cron/__tests__/yield-resolve.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts
```

## W2 - Coverage Truth Model And Guardrails

### Goal

Make yield coverage explicit, enforceable, and auditable for every yield-bearing asset.

### Problems Closed

- Finding 2 directly
- Finding 6 directly
- missing live-coverage blind spots

### Main Surfaces

- `worker/src/cron/yield-config.ts`
- `worker/src/cron/yield-coverage-audit.ts`
- `worker/src/cron/sync-yield-data.ts`
- new registry or manifest module

### Implementation

1. Introduce a first-class strategy manifest as the source of truth.
   - Each yield-bearing asset must declare one of:
     - `deterministic`
     - `curated-protocol`
     - `protocol-api`
     - `auto-discovery-override`
     - `price-derived`
     - `rate-derived`
     - `intentional-gap`
     - `quarantined`
   - Fallback order must be explicit in the manifest.
2. Make implicit strategies explicit.
   - `cetes-etherfuse` must stop being covered only via implicit nav-token behavior.
   - Any nav-token price-derived strategy should have an explicit manifest entry, label, and rationale.
3. Backfill all `49` yield-bearing coins into the new manifest.
   - No yield-bearing coin should be absent from the manifest.
   - `usg-tangent` must either gain an explicit strategy or be marked as an intentional gap with rationale.
4. Rewrite `YIELD_ADAPTER_MANIFEST` as a generated view over the new manifest, or retire it.
5. Rewrite `yield-coverage-audit.ts`.
   - It should understand:
     - native DL pool coverage
     - variant coverage
     - on-chain deterministic coverage
     - protocol-native coverage
     - explicit fallbacks
     - intentional gaps
     - missing live-ranking presence
   - `trackedSymbols` should either become a real part of the analysis or be removed.
6. Fix the coverage regression guard in `sync-yield-data.ts`.
   - Primary guard should operate on yield-bearing assets only.
   - Recommended metrics:
     - `resolvedYieldBearingCount / manifestExpectedCount`
     - `publishedYieldBearingCount / previousPublishedYieldBearingCount`
   - Non-yield-bearing discovered rows must not inflate the protection metric.
7. Add runtime visibility for fragile coverage.
   - Track:
     - missing-from-manifest
     - intentional-gap
     - ambiguous-drop
     - yield-bearing-missing-from-rankings

### Acceptance Criteria

- Every yield-bearing coin has explicit strategy metadata or explicit intentional-gap metadata.
- Coverage audit can explain why each yield-bearing coin is or is not covered.
- Coverage guard is immune to dilution from non-yield-bearing discovered rows.

### Validation

Add tests for:

- manifest completeness over `YIELD_BEARING_STABLECOINS`
- explicit intentional-gap handling
- coverage regression guard with non-yield-bearing extra rows
- coverage audit recognizing non-DL strategies as real coverage
- live ranking presence invariant for yield-bearing assets

## W3 - Adapter-Specific Corrections And Gap Closure

### Goal

Fix the adapter-level quality and methodology issues identified in the audit, and close the current live coverage gaps.

### Problems Closed

- BIMA, Hashnote, Ondo issues
- Morpho/Pendle/Yearn/Kong/Beefy/Compound/Aave adapter issues
- missing live coverage for `usbd-bima`, `usg-tangent`, `ftusd-flying-tulip`
- fragile single-path coverage

### Main Surfaces

- `worker/src/cron/yield-sync/sources.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- new adapter-specific modules after refactor if W5 lands before all adapter work is complete

### Implementation

#### 1. BIMA

- Enforce minimum quality thresholds before publishing:
  - minimum positive APY
  - minimum TVL threshold
  - explicit bootstrap/degraded behavior for zero-rate or near-zero-TVL states
- Decide whether low-quality states should:
  - drop the row
  - retain prior row with degraded provenance
  - or surface explicit zero-yield if and only if the source is materially live and meaningful
- Close live ranking absence for `usbd-bima`.

#### 2. Hashnote

- Sort reports by timestamp before using them.
- Anchor from the first row at or before the target window in the sorted series.
- Add minimum-window and freshness validation.

#### 3. Ondo USDY

- Stop annualizing off the immediately previous persisted row.
- Move to a defined anchor policy:
  - preferred: closest row at or before 7 days
  - fallback: bounded shorter window with degraded provenance only if explicitly allowed
- Preserve bootstrap behavior separately from mature APY behavior.

#### 4. Morpho

- Extend the query to return underlying asset address if supported.
- If asset address is unavailable, define an explicit fallback rule:
  - chain-aware unique symbol only
  - ambiguous rows dropped
- Carry chain identity into the resolved source key and label.

#### 5. Pendle

- Resolve by underlying asset address and chain, not by display symbol.
- Review whether `assetRepresentation` is presentation-only or part of identity.
- Add pagination or a completeness guard around the `limit=100` call.
- Make supported chain list explicit and reviewable.

#### 6. Yearn/Kong

- Determine whether an underlying asset address is available from the API or a secondary metadata call.
- If not, use a curated allowlist/registry for ambiguous symbols and refuse first-match behavior.
- Separate Yearn and Kong source key namespaces if the economic source differs.

#### 7. Beefy

- Use chain and token address from the upstream payload for identity.
- Add a stronger quality policy:
  - better APY sanity rules
  - TVL if obtainable from upstream or a companion endpoint
  - otherwise a stricter allowlist and explicit degraded behavior

#### 8. Compound V3

- Replace truncated source keys with full comet identifiers.
- Make resolver mapping explicit rather than relying on a raw symbol lookup.

#### 9. Aave V3

- Change to a valid shared `YieldType`.
- Make source identity chain-aware.
- Preserve the winning chain in source key, label, and provenance.

#### 10. B.Protocol

- Keep logic mostly intact unless source key normalization or provenance improvements require a small touch.
- No large refactor is required here unless uncovered during implementation.

#### 11. Fallback lanes

- Make `price-derived` and `rate-derived` explicit manifest strategies with explicit labels and provenance semantics.
- Review single-path assets:
  - `cetes-etherfuse`
  - `dusd-dtrinity`
  - `usdh-hermetica`
  - `ftusd-flying-tulip`
- Each must end implementation in one of two states:
  - explicit reliable strategy
  - explicit intentional-gap/degraded strategy with operator visibility

#### 12. Gap-closure assets

- `usg-tangent`
  - research and select the best reliable strategy
  - if no reliable strategy exists, mark as intentional gap and alert instead of silent absence
- `ftusd-flying-tulip`
  - add explicit strategy or explicit intentional-gap handling
- `usbd-bima`
  - improved direct adapter must result in explicit coverage semantics

### Acceptance Criteria

- All adapter-specific findings from the audit are closed or explicitly deferred with rationale.
- No yield-bearing asset remains silently uncovered.
- Direct-adapter methodology is explicit and test-covered.

### Validation

Add or extend tests for:

- `yield-bima-source.test.ts`
- `yield-hashnote-source.test.ts`
- `yield-ondo-source.test.ts`
- `yield-morpho-source.test.ts`
- `yield-pendle-source.test.ts`
- `yield-yearn-kong-source.test.ts`
- `yield-beefy-source.test.ts`
- `yield-compound-v3-source.test.ts`
- `yield-aave-onchain-source.test.ts`
- `sync-yield-data.test.ts`

## W4 - Publication, Provenance, Warning, And Link Consistency

### Goal

Make the published snapshot, persisted rows, warning system, and source-linking behavior consistent and trustworthy.

### Problems Closed

- Finding 5 directly
- Finding 7 directly
- Finding 8 directly
- Finding 9 partially
- source-link issues directly

### Main Surfaces

- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/yield-sync/evaluation.ts`
- `worker/src/cron/yield-sync/publication.ts`
- `worker/src/lib/yield-source-links.ts`
- shared yield types and API contracts as needed

### Implementation

1. Unify the median policy.
   - Choose one canonical peer benchmark for:
     - stored warning evaluation
     - published rankings payload
     - any operator metrics
   - Prefer one explicit definition rather than mixing current APY simple median with TVL-weighted 30d median.
2. Extract shared provenance building into one helper.
   - Preview payload and persisted rows must derive:
     - `sourceObservedAt`
     - `sourceAgeSeconds`
     - `comparisonAnchorObservedAt`
     - `selectionReason`
     - `sourceSwitch`
     - anomaly metadata
     from the same function.
3. Introduce a publish-consistent snapshot model.
   - Recommended implementation:
     - create a `run_id` or snapshot id
     - persist evaluated rows under that id
     - publish rankings cache for that id
     - only then promote that id as current and prune superseded data
   - If a lighter approach is chosen, it must still guarantee that history and rankings cannot disagree about which run is current.
4. Normalize source keys and labels where required.
   - Full keys for Morpho, Pendle, Yearn/Kong, Beefy, Compound, Aave
   - chain-aware Aave identity
5. Fix source-link resolution.
   - Add prefix-aware matching for labels like:
     - `Morpho: ...`
     - `Pendle: ...`
     - `Yearn: ...`
     - `Kong: ...`
     - `Beefy: ...`
   - Keep curated exact-match support for plain labels.
6. Remove any schema-invalid or stale casts that can bypass compile-time checking.
   - For example, stop casting arbitrary strings to `AltYieldSource["yieldType"]`.

### Acceptance Criteria

- Public median and warning median use the same policy.
- Preview and persisted provenance cannot drift.
- A failed cache publication cannot leave a newer “current” DB snapshot than the published rankings snapshot.
- Source links for protocol-native rows point to the actual protocol, not back to the issuer site by default.

### Validation

Add tests for:

- median consistency between evaluation and publication
- failed cache publish leaves current snapshot unchanged
- Aave rows schema-validate in a full publish path
- prefixed source labels resolve to correct URLs

## W5 - Structural Refactor And LOC Reduction

### Goal

Reduce hotspot size and configuration drift after correctness is stabilized.

### Problems Closed

- monolithic hotspot files
- fragmented adapter registration
- stringly typed config
- duplicated provenance logic
- unused reconstruction code

### Main Surfaces

- `worker/src/cron/yield-config.ts`
- `worker/src/cron/yield-sync/sources.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-sync/publication.ts`
- new registry/adapter modules

### Implementation

1. Split `yield-config.ts` into smaller registry modules.
   - Suggested shape:
     - `yield-registry/manifest.ts`
     - `yield-registry/defillama.ts`
     - `yield-registry/fallbacks.ts`
     - `yield-registry/protocols.ts`
2. Split `sources.ts` by family.
   - Suggested shape:
     - `adapters/direct/`
     - `adapters/protocol-native/`
     - `adapters/onchain/`
3. Split resolver responsibilities.
   - identity resolution
   - strategy execution
   - arbitration input assembly
4. Convert stringly typed config fields to shared types.
   - `YieldType`
   - typed strategy kinds
   - typed source-family enums where helpful
5. Remove unused `buildYieldRankingsPayload()` if it remains unused after W4.
6. Deduplicate provenance and source-link helper logic into focused modules.

### Acceptance Criteria

- No single file remains the only place where unrelated adapter families and registry policy coexist.
- Strategy registration is generated from one source of truth.
- Unused reconstruction code is gone.

### Validation

- `rg -n "buildYieldRankingsPayload\\(" .` no longer returns an unused definition
- existing tests still pass after module moves
- any newly introduced helpers have focused unit coverage

## W6 - Validation, Rollout, And Documentation

### Goal

Make the remediation enforceable in CI, locally, and during production rollout.

### Problems Closed

- test/observability gaps from the audit
- missing live coverage invariants
- missing documentation alignment

### Main Surfaces

- tests
- smoke scripts
- docs
- operator runbooks if applicable

### Implementation

1. Add missing invariant tests.
   - every yield-bearing coin present in manifest
   - every live ranking canary present after a healthy run
   - override pools cannot be dynamically reused
   - protocol-native ambiguous rows are dropped, not guessed
2. Add a yield-specific smoke script or extend an existing one.
   - Validate:
     - rankings cache exists
     - representative canaries are present
     - collision canaries resolve to distinct source identities
     - provenance fields are populated
3. Update docs in lockstep with implementation.
   - Required:
     - `docs/yield-intelligence.md`
     - `docs/yield-intelligence-timeline.md`
     - `docs/api-reference.md` if contracts change
     - `docs/testing.md` for new validation/smoke expectations
   - Conditional:
     - `src/app/methodology/methodology-sections.tsx`
     - `docs/about-page.md` if a new external source is introduced
4. Define rollout gates for production.
   - Worker/API changes deploy first.
   - Run canary checks after first successful yield cron.
   - Pages/frontend changes only deploy after worker output is verified.
   - Watch the next two affected cron runs for:
     - degraded status
     - missing canaries
     - unexpected coverage shrink
     - publication failure
     - ambiguous-drop spikes

### Acceptance Criteria

- Every audit finding has a corresponding automated test, smoke, invariant, or rollout check.
- Documentation reflects the remediated strategy model and methodology.
- No push happens without the full local merge gate.

### Validation Commands

Run before push:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Recommended Phase Order

### Phase 1

- W0 Ground Truth And Safety Harness
- W1 Identity And Matching Hardening
- immediate correctness blockers from W4:
  - Aave `yieldType`
  - source key normalization where required for correctness

Ship criteria:

- live collision cases covered by tests
- no guessed symbol-only attachments in ambiguous cases

### Phase 2

- W2 Coverage Truth Model And Guardrails

Ship criteria:

- every yield-bearing asset has explicit manifest state
- coverage guard no longer diluted by non-yield-bearing rows

### Phase 3

- W3 Adapter-Specific Corrections And Gap Closure

Ship criteria:

- direct-adapter methodology fixes landed
- missing live coverage assets closed or intentionally surfaced as gaps

### Phase 4

- remaining W4 Publication, Provenance, Warning, And Link Consistency work

Ship criteria:

- public median and warning median are unified
- rankings/history surfaces read from the same published snapshot semantics

### Phase 5

- W5 Structural Refactor And LOC Reduction

Ship criteria:

- no functional changes beyond the already validated behavior
- hotspot reduction complete

### Phase 6

- W6 Validation, Rollout, And Documentation hardening complete if any pieces are still open

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Address-first identity drops rows that used to “resolve” by lucky symbol match | High | Medium | Treat dropped ambiguous rows as success, not regression; cover with canaries and coverage accounting |
| Some protocol APIs do not expose enough identity metadata for robust matching | Medium | High | Use curated registry/allowlist for ambiguous protocols and refuse first-match behavior |
| Coverage audit rewrite drifts from runtime behavior again | Medium | Medium | Generate derived audit views from the same manifest/registry used at runtime |
| Snapshot publication changes are invasive | Medium | High | Land behind a dedicated PR with explicit integration tests for failed publish paths |
| Refactor work obscures behavior changes | Medium | Medium | Land structural refactor only after correctness behavior is stabilized and test-covered |

## Success Criteria

The remediation is complete when all of the following are true:

1. The duplicate-symbol live misattribution cases from the audit no longer reproduce.
2. Yield-bearing coverage is explicit for all assets, with no silent gaps.
3. `api.pharos.watch/api/yield-rankings` includes all intended yield-bearing assets or explicitly signals intentional gaps/degraded states.
4. Aave and all other adapters produce schema-valid rows in end-to-end publish tests.
5. Warnings, provenance, and public median use a coherent methodology.
6. Source links for protocol-native rows resolve to the actual yield venue.
7. The codebase no longer depends on fragmented parallel registries for adapter identity.
8. Full local validation and merge gate pass before push.

## Final Recommendation

Treat W1 and W2 as a hard gate for the rest of the work. The audit showed that the module’s biggest problem is not lack of data sources; it is lack of disciplined source identity and coverage truth. Fixing adapters before that foundation is corrected will produce more data, but not necessarily better data.
