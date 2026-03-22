# Tier 2 Remediation Plan

Date: 2026-03-20
Source audit: `agents/audits/2026-03-20-simplification-audit.md`
Scope: Tier 2 only

## Objective

Land the medium-effort, high-value refactors after Tier 1:

1. Collapse Telegram webhook disambiguation into one action-resolution runner.
2. Remove current layer inversions between `src/components/`, `src/lib/`, `src/hooks/`, `worker/src/api/`, and `worker/src/cron/`.
3. Reduce `src/components/stablecoin-detail/hero-card.tsx` by extracting repeated responsive substructures.

The work should reduce maintenance cost without changing product behavior.

## Workstreams

### 1. Telegram Webhook Resolution Runner

Current duplication lives in:

- `worker/src/api/telegram-webhook.ts`
  - `handleSubscribe()`
  - `handleUnsubscribe()`
  - `handleSet()`
  - `handleDisambiguationReply()`

Implementation sequence:

1. Add characterization tests around subscribe/unsubscribe/set and pending disambiguation continuation.
2. Extract one resolver function, likely in `worker/src/api/telegram-webhook-resolution.ts`, that returns:
   - `not_found`
   - `ambiguous`
   - `complete`
3. Make action-specific pieces injectable:
   - pending payload builder
   - completion callback
   - success message builder
4. Update both initial command handlers and the pending-reply path to use the same runner.
5. Keep `/cancel`, pending TTL, quiet-hours payloads, and alert-type semantics unchanged.

Verification:

- `worker/src/api/__tests__/telegram-webhook.test.ts`
- `worker/src/api/__tests__/telegram-webhook-auth.test.ts`
- `cd worker && npx tsc --noEmit`

### 2. Layer Boundary Cleanup

Current inversions:

- `src/lib/status-dashboard-model.ts` imports:
  - `src/components/status/action-recommendations.ts`
  - `src/components/status/cron-config.ts`
- `src/lib/compare-config.ts` imports:
  - `src/components/coin-selector.tsx`
  - `src/components/compare-empty-state.tsx`
- `src/hooks/use-compare-selection.ts` imports `CoinOption` from `src/components/coin-selector.tsx`
- `worker/src/cron/status-self-check.ts` imports `evaluateStatusAndPersist` from `worker/src/api/status.ts`

Implementation sequence:

1. Move status-page domain helpers into `src/lib/status/`:
   - `deriveStatusActionRecommendations()`
   - `getStatusCronDisplay()`
2. Update `src/lib/status-dashboard-model.ts` and any status components to import from the new lib location.
3. Create `src/lib/compare-types.ts` for:
   - `CoinOption`
   - `ComparePreset`
4. Update:
   - `src/components/coin-selector.tsx`
   - `src/components/compare-empty-state.tsx`
   - `src/lib/compare-config.ts`
   - `src/hooks/use-compare-selection.ts`
5. Move `evaluateStatusAndPersist()` into `worker/src/lib/status-evaluation.ts`.
6. Update both:
   - `worker/src/api/status.ts`
   - `worker/src/cron/status-self-check.ts`

Verification:

- `npm test -- worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/status-history.test.ts`
- `npm test -- src/components/__tests__/action-recommendations.test.ts src/components/__tests__/cron-config.test.ts src/lib/__tests__/compare-config.test.ts`
- `npm run check:worker-boundary`
- `cd worker && npx tsc --noEmit`

### 3. Hero Card Substructure Extraction

Current duplication lives in:

- `src/components/stablecoin-detail/hero-card.tsx`

Likely repeated units:

- title / logo / taxonomy header
- price / gauge block
- metric-card body content reused across mobile and desktop layouts

Implementation sequence:

1. Snapshot current rendering behavior with a focused component test if coverage is missing.
2. Extract small local subcomponents inside the same file first:
   - `HeroIdentityBlock`
   - `HeroPriceBlock`
   - `HeroMetricCardContent` variants as needed
3. Keep layout containers separate for mobile vs desktop; only share repeated content, not the whole layout tree.
4. Stop when the file is materially smaller and the mobile/desktop sections no longer repeat the same content blocks verbatim.

Verification:

- relevant stablecoin detail component tests
- `npm run lint`
- `npm run build`

## Recommended Order

1. Telegram resolution runner
2. Layer boundary cleanup
3. Hero-card reduction

Reasoning:

- Telegram has the biggest bug-surface reduction.
- Layer cleanup unlocks cleaner ownership before more frontend changes.
- Hero-card extraction is easier once compare/status ownership is settled.

## Merge Strategy

Use three PRs:

1. Telegram runner + tests
2. Layer boundary cleanup
3. Hero-card extraction

Keep each PR behavior-preserving and independently shippable.
