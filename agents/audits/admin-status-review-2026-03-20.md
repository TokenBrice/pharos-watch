# `/admin/` + `/status/` Review

Date: 2026-03-20

## Scope

- Reviewed the route shells, shared status model, hooks, status components, Pages Functions host/proxy layer, and the worker-side `/api/health`, `/api/status`, and `/api/status-history` implementations.
- Cross-checked the current implementation against `docs/status-dashboard.md`, `docs/api-reference.md`, `docs/architecture.md`, `docs/operator-origin-access.md`, and `docs/worker-infrastructure.md`.
- This is a source-based audit. I did not review a live Access-authenticated ops session, so the `/admin/` findings are based on the code path and contracts rather than a production screenshot pass.

## Executive Summary

The two pages already have good raw data and a fairly complete backend contract. The main problem is not a lack of telemetry. The problem is that the pages do not consistently represent that telemetry with the same semantics the backend uses, and they hide too much of the most important state behind generic tables, repeated blocker summaries, or raw machine strings.

The highest-value improvements are:

1. Fix semantic drift between the UI and the worker contract.
2. Promote already-available but currently hidden operator signals.
3. Reduce scan cost by making failure-first views the default and pushing healthy/noisy detail behind disclosure.

## Cross-Surface Findings

### 1. Browser probes are transport-only, while the worker self-check is semantic

`src/hooks/use-endpoint-probes.ts` records only `{ path, status, latencyMs, error? }`. The worker-side self-check explicitly parses `/api/health` semantically and downgrades a `200` response whose body status is `degraded` or `stale`.

Why this matters:

- Both `/status/` and `/admin/` can count `/api/health` as a passing probe even when the public health payload itself says the system is degraded or stale.
- The public page mixes "this browser can reach the route" with "the route is actually healthy" without enough separation.
- Browser probes also cannot distinguish local network problems from system problems.

Recommended change:

- Introduce a richer probe result model with at least `httpStatus`, `semanticStatus`, `warning`, and `scope`.
- Special-case `/api/health` in the browser probe loop the same way the worker self-check does.
- Label browser probes explicitly as "local browser reachability" and keep semantic health separate.

Primary files:

- `src/hooks/use-endpoint-probes.ts`
- `src/lib/status-dashboard-model.ts`
- `src/components/status/endpoint-health-grid.tsx`
- `worker/src/cron/status-self-check.ts`
- `docs/status-dashboard.md`

### 2. Cache freshness UI strips away important cache semantics that the backend already exposes

`worker/src/lib/api-utils.ts` and `shared/types/status.ts` support rich cache state: `mode`, `sourceStatus`, `sourceUpdatedAt`, `sourceAgeSeconds`, `warning`, and `consecutiveFallbackRuns`. The current cache UI accepts only `ageSeconds`, `maxAge`, and `healthy`.

Why this matters:

- The pages cannot accurately represent FX fallback mode, stale source feeds, or cached-fallback conditions.
- A cache can look "ok" by age ratio while the source behind it is degraded or stale.
- The public hero computes its own "worst cache" status from ratio alone, which can under-report actual cache issues.

Recommended change:

- Replace the narrow cache table contract with the full `CacheStatus`.
- Surface cache mode, source freshness, and warning text directly in both `/status/` and `/admin/`.
- Collapse fully healthy caches by default and pin degraded/stale/fallback caches to the top.

Primary files:

- `worker/src/lib/api-utils.ts`
- `shared/types/status.ts`
- `src/components/status/cache-freshness-table.tsx`
- `src/app/status/client.tsx`
- `src/app/admin/client.tsx`

### 3. The dashboard fetches more state than it actually renders

The worker includes `reserveDrift` and `classificationWarnings` in `/api/status`, but the admin UI never renders them. `useStatusHistory()` also fetches `state`, `staleness`, `probe`, and `discrepancy`, but the current history lane only uses `transitions`.

Why this matters:

- Important operator signals are already available but invisible.
- The history lane cannot show incident-system drift, probe behavior, or state-machine context over time even though the endpoint returns it.
- The page looks less capable than the backend actually is.

Recommended change:

- Add a reserve-governance integrity section to `/admin/` for `reserveDrift` and `classificationWarnings`.
- Use the extra `status-history` fields in the history lane instead of throwing them away.
- If a signal is intentionally not meant for UI yet, stop fetching it until the surface is ready.

Primary files:

- `worker/src/api/status.ts`
- `worker/src/api/status-history.ts`
- `src/hooks/use-status-dashboard-model.ts`
- `src/app/admin/client.tsx`

### 4. The top-level "client freshness" signal can overstate how current the page really is

`useStatusDashboardModel()` computes `lastUpdated` as the max of status, health, and probe query timestamps. The top fold then derives a single `Client Sync` and `Client Age` from that max value.

Why this matters:

- One fast-moving query can make the whole page look fresh while another key query is stale.
- This is especially misleading on `/admin/`, where status, public health, probes, and history have different diagnostic roles.

Recommended change:

- Track per-query freshness in the model and surface the oldest important source, not the newest source.
- Show separate timestamps for status, history, public health, and browser probes, or a compact "stale source" summary when one lags.

Primary files:

- `src/hooks/use-status-dashboard-model.ts`
- `src/lib/status-dashboard-model.ts`
- `src/app/admin/client.tsx`

### 5. The action recommendation layer is too narrow for the amount of state the page exposes

`src/components/status/action-recommendations.ts` only maps a small subset of causes and cron lanes to actions.

Why this matters:

- The page promotes "Recommended now" as the shortest path in, but many real incidents will produce no recommendation or an incomplete one.
- This weakens operator trust in the promoted action strip.

Recommended change:

- Expand the cause-to-action registry to cover reserve sync, price-source degradation, liquidity scorer problems, daily snapshot failures, and Telegram dispatch issues.
- Add a fallback "why there is no suggested action" explanation when a serious cause has no mapped tool.
- Track action relevance by domain and severity rather than only by hardcoded cause code.

Primary files:

- `src/components/status/action-recommendations.ts`
- `src/components/status/recommended-action-strip.tsx`
- `src/components/status/admin-actions-panel.tsx`

## `/status/` Findings

### 6. The public page does not explain which public surfaces are actually affected

The current public hero and overview tell the reader that the public surface is steady, under pressure, or compromised, but they do not map bad caches or failing probes back to impacted pages or datasets.

Why this matters:

- A user cannot quickly answer "what should I distrust right now?"
- The page has telemetry, but not enough impact framing.

Recommended change:

- Add an "Impacted public surfaces" module that maps stale cache keys and failed canary routes to user-facing pages and APIs.
- Example buckets: market overview, flows, blacklist tracker, stablecoin detail, reserves, yield, safety scores, digest.

Primary files:

- `src/app/status/client.tsx`
- `src/components/status/public-status-hero.tsx`
- `src/components/status/cache-freshness-table.tsx`
- `shared/lib/api-endpoints.ts`

### 7. The public mint/burn and blacklist cards do not match the actual health semantics

The public page uses simplified card logic:

- Mint/burn tone is derived only from `freshnessStatus`, even though `/api/health` also returns `criticalLaneHealthy` and warning text for recent error/degraded runs.
- Blacklist surfacing uses only `missingAmounts`, while the actual status logic is driven by ratio thresholds and recent-missing counts.

Why this matters:

- The page can underplay a mint/burn lane error when the last successful sync is still recent.
- The blacklist card does not show the metrics the backend actually uses to degrade/stale the system.

Recommended change:

- Make the mint/burn card reflect both freshness and latest critical-lane run health.
- Extend `/api/health.blacklist` with `missingRatio`, `recentMissingAmounts`, and `recentWindowSec`, then render those explicitly.

Primary files:

- `src/app/status/client.tsx`
- `worker/src/api/health.ts`
- `shared/types/status.ts`
- `worker/src/lib/mint-burn-health-config.ts`

### 8. Public warnings are surfaced as raw strings instead of structured health signals

The notice rail on `/status/` renders `healthData.warnings` almost verbatim and labels each one as a generic "Health warning".

Why this matters:

- These strings are machine-oriented and inconsistent in tone.
- Users cannot tell whether a warning is a trust issue, a freshness issue, a local browser issue, or an internal diagnostic failure.

Recommended change:

- Parse known warning types into structured public warning cards.
- Group warnings into at least: "data trust", "route reachability", and "monitoring degraded".
- Keep the raw string only in an expandable diagnostic footer.

Primary files:

- `src/app/status/client.tsx`
- `src/components/status/page-primitives.tsx`
- `worker/src/api/health.ts`

### 9. The public reliability lane is accurate only for this browser, but that is not emphasized strongly enough

`/status/` runs browser probes from the viewer session. The copy mentions "this session", but the layout still presents the probe board as a major reliability surface.

Why this matters:

- Viewers may interpret one user's local-network failure as system failure.
- Every viewer also triggers a multi-endpoint probe loop, which can create noise and unnecessary load.

Recommended change:

- Demote browser probes below server-side health signals on the public page.
- Add clearer copy that this is a local sample, not a canonical monitor.
- Consider probing a much smaller public canary set unless the reader expands an advanced diagnostics section.

Primary files:

- `src/hooks/use-endpoint-probes.ts`
- `src/components/status/endpoint-health-grid.tsx`
- `src/app/status/client.tsx`

### 10. The public page lacks recent-incident context

The page shows current status only. There is no public "changed recently" or "last incident" summary.

Why this matters:

- Readers cannot tell whether a degraded state is new, persistent, or already recovering.
- This limits trust and makes the page less actionable.

Recommended change:

- Add a lightweight public incident summary: last status change, current hold duration, and recent resolved incidents.
- If the existing admin history endpoint should stay private, expose a safe public subset instead of reusing the full operator contract.

Primary files:

- `src/app/status/client.tsx`
- `worker/src/api/status-history.ts`
- `shared/types/status.ts`

## `/admin/` Findings

### 11. The admin top fold is visually strong but overloaded and repetitive

The admin top fold includes:

- the status hero
- current blockers
- recommended actions
- follow-this-order lane navigation
- multiple timestamp chips

Why this matters:

- The page repeats the same information in several different forms before the operator reaches the first detailed lane.
- It is harder than necessary to decide what to read first.

Recommended change:

- Compress the hero into a smaller incident header.
- Keep only one blocker summary above the fold.
- Keep the recommended action strip, but move the lane-order card into the sticky nav or collapse it by default.

Primary files:

- `src/app/admin/client.tsx`
- `src/components/status/status-banner.tsx`
- `src/components/status/recommended-action-strip.tsx`

### 12. Incident detail hides too much of the real cause graph

The main blocker list uses `causes.overall`, and the top fold uses a further reduced `topCauses` slice. The full availability and data-quality cause arrays are never surfaced as first-class grouped views.

Why this matters:

- Operators cannot see the full active cause set without inferring it from downstream cards.
- The page over-optimizes for summary and under-serves actual diagnosis.

Recommended change:

- Add a grouped cause board that shows all availability causes and all data-quality causes, sorted by severity.
- Keep `causes.overall` only as the condensed executive summary.

Primary files:

- `src/components/status/status-facts.tsx`
- `src/lib/status-dashboard-model.ts`
- `worker/src/api/status.ts`

### 13. Reliability lane includes "Manual Actions" as probe noise

`EndpointHealthGrid` defaults to `public`, `admin`, and `manual`. In the admin reliability lane, manual actions are rendered as a full "Not probed" block.

Why this matters:

- This adds noise to the lane that should be about actual route health.
- It reduces scan speed without adding diagnostic value.

Recommended change:

- Remove manual actions from the reliability lane entirely.
- If you want to document them, keep them only in the action lane.

Primary files:

- `src/components/status/endpoint-health-grid.tsx`
- `src/app/admin/client.tsx`

### 14. The action shelf is flat and underspecified

`AdminActionsPanel` renders all actions in a flat grid. `AdminActionButton` uses a generic confirmation modal and does not send idempotency keys.

Why this matters:

- Safe read actions and destructive write actions are mixed together.
- Operators get no domain grouping, no expected runtime, no last-known effect, and no protection against accidental replays on idempotent endpoints.

Recommended change:

- Group actions by domain: data repair, diagnostics, backfills, messaging, and destructive reset.
- Mark read-only vs mutating vs destructive explicitly.
- Send an `Idempotency-Key` for the endpoints that support it.
- Add optional action-specific context in the confirmation dialog: expected duration, likely downstream effect, and what to check afterward.

Primary files:

- `src/components/status/admin-actions-panel.tsx`
- `src/components/status/admin-action-button.tsx`
- `shared/lib/api-endpoints.ts`
- `docs/api-reference.md`

### 15. Discovery candidate dismissal is only locally reflected and has weak empty-state behavior

`DiscoveryCandidatesCard` keeps a local `dismissed` set and never calls back into the parent for a refresh.

Why this matters:

- The card count is only locally accurate until the next poll.
- If every visible candidate is dismissed locally, the card becomes blank instead of showing a clean zero state.

Recommended change:

- Trigger a parent refresh after successful dismiss.
- Show a proper post-dismiss zero state.
- Consider surfacing why the candidate matters, not just symbol and market cap.

Primary files:

- `src/components/status/discovery-candidates.tsx`
- `src/app/admin/client.tsx`

### 16. History is truncated and underused

`useStatusHistory()` hardcodes `limit=100` even though the endpoint allows up to 200. The UI also discards the non-transition fields returned by `/api/status-history`.

Why this matters:

- A 30-day window can be incomplete without telling the operator it is incomplete.
- The lane does not show how probe health or the state machine evolved alongside transitions.

Recommended change:

- Raise the default limit or add pagination.
- Show truncation explicitly when the returned transition count hits the limit.
- Add a compact state/probe snapshot timeline above the transition list.

Primary files:

- `src/hooks/use-status-history.ts`
- `src/components/status/transition-timeline.tsx`
- `worker/src/api/status-history.ts`

### 17. Reserve-integrity and classification signals are missing from the UI

`/api/status` returns `reserveDrift` and `classificationWarnings`, but `/admin/` never renders them.

Why this matters:

- Two high-value integrity checks are effectively dead from an operator perspective.
- Reserve sync currently shows counts, but not whether the live reserve model is disagreeing with the curated model.

Recommended change:

- Add a "Reserve integrity" card for live-vs-curated drift.
- Add a "Classification review" card for governance/custody warnings.

Primary files:

- `worker/src/api/status.ts`
- `src/app/admin/client.tsx`

### 18. Price source health is documented as richer than it really is

The docs describe a divergences list, but the current `PriceSourceHealthCard` only shows confidence distribution and a long single-line source breakdown. The endpoint contract also does not currently expose divergence rows.

Why this matters:

- The docs and product intent are ahead of the implementation.
- The current card is harder to scan than it should be, especially on smaller screens.

Recommended change:

- Either implement the missing divergence feed and render it, or update the docs to match reality.
- Break the source line into grouped badges or a compact table instead of one long sentence.

Primary files:

- `src/components/status/price-source-health.tsx`
- `worker/src/cron/sync-stablecoins.ts`
- `shared/types/status.ts`
- `docs/status-dashboard.md`

### 19. Some summary labels understate severity

Two examples:

- The DB summary card in `StatusFacts` shows `degraded` when `dbHealthy` is false, even though the backend treats DB failure as a critical stale fallback state.
- The public host fallback branch inside `src/app/admin/client.tsx` suggests a live route-level UX that is actually hard-blocked by `functions/admin/[[path]].ts`.

Why this matters:

- Operators should not see softened labels for hard failure conditions.
- The codebase currently contains route behavior that does not align cleanly with the deployed host-gate contract.

Recommended change:

- Rename the DB state to `unhealthy` or `down`.
- Remove or simplify the unreachable public-host admin branch unless local-only behavior is intentionally desired.

Primary files:

- `src/components/status/status-facts.tsx`
- `src/app/admin/client.tsx`
- `functions/admin/[[path]].ts`

## Structure And UI Recommendations

These are the page-level changes I would make after fixing the semantic issues above.

### `/status/`

1. Keep the current public hero, but replace the two overview cards with three direct public-trust modules:
   `Trust now`, `Affected surfaces`, and `What changed`.
2. Move browser probes behind an "Advanced diagnostics" disclosure.
3. Turn raw warnings into structured cards.
4. Replace the cache table with a failure-first list that highlights only degraded/stale/fallback lanes by default.

### `/admin/`

1. Shrink the hero into an incident header plus promoted action strip.
2. Put the grouped cause board immediately after the hero.
3. Keep lane ordering, but make it evidence-first: root cause, then repair tools, then telemetry, then history.
4. Collapse all healthy cron groups, healthy probes, and healthy cache rows by default.
5. Convert mobile-hostile tables into stacked cards or segmented lists for the highest-priority rows.

## Proposed Implementation Order

### Phase 1: Accuracy fixes

1. Add semantic browser probe evaluation.
2. Upgrade cache rendering to use full `CacheStatus`.
3. Fix public mint/burn and blacklist semantics.
4. Fix top-level freshness accounting in the dashboard model.
5. Surface all active causes by layer.

### Phase 2: Missing signal surfacing

1. Add reserve drift and classification warning cards.
2. Improve action recommendations and action grouping.
3. Add impacted-surface mapping on `/status/`.
4. Expand history beyond transitions.

### Phase 3: Structural/UI cleanup

1. Compress the admin top fold.
2. Collapse healthy/noisy detail everywhere.
3. Rework public advanced diagnostics so the page defaults to trust-impact-first, not plumbing-first.

## Testing Gaps

The worker status endpoints are tested, but there is no comparable frontend coverage for the status surfaces themselves.

Recommended additions:

1. Frontend model tests for semantic probe classification, lane ordering, and freshness-staleness math.
2. Component tests for cache rendering, blocker grouping, and action recommendation display.
3. Route-level UI tests for `/status/` and `/admin/` covering degraded, stale, recovery-hold, and DB-unhealthy states.
4. A smoke test that explicitly verifies the public page never represents a semantically degraded `/api/health` response as a passing healthy probe.

## Doc Drift To Address During Implementation

1. `docs/status-dashboard.md` currently describes price-source divergences that the UI and type contract do not yet expose.
2. Any `/api/health` expansion for public blacklist or incident-summary data will require updates to `docs/api-reference.md` and `docs/status-dashboard.md`.
3. Any admin action UX that starts relying on idempotency keys or new action grouping metadata should be reflected in the API reference and status dashboard docs.
