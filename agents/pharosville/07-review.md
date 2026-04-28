# Independent Review And Revisions

Reviewer: specialized GPT-5.5 xhigh subagent  
Date: 2026-04-28

## Review Verdict

Original review verdict: conditional go.

The reviewer found the architecture feasible and directionally correct, but not ready for implementation before tightening data contracts, accessibility, performance, and rollout gates.

## Required Fixes Folded Into Pack

1. Active/frozen universe handling:
   - Added requirement to build ships only from `ACTIVE_IDS` / `ACTIVE_META_BY_ID` and `asset.frozen !== true`.
   - Added requirement to render frozen assets only through `CEMETERY_ENTRIES`.

2. Shared supply helpers:
   - Added requirements for `getCirculatingRaw()`, previous-period helpers, `canonicalizeChainCirculating()`, and `findCanonicalChainData()`.
   - Repeated no-price-multiplication rule.

3. Exact risk placement:
   - Added required `resolveShipRiskPlacement()` pure function and precedence order.

4. Depeg hook/API correction:
   - Removed any MVP dependency on a nonexistent `useDepegEvents()`.
   - Documented `pegSummary.coins[].activeDepeg` as MVP active-depeg source.
   - Deferred active depeg-event loading unless hook/API path is intentionally extended.

5. Canvas exception:
   - Added explicit exception to `docs/data-visualization.md`'s SVG-over-Canvas norm and compensating gates.

6. Performance budget:
   - Added effective DPR/backing-store budget model, cache release requirements, and canvas-budget tests.

7. Accessibility:
   - Added operational keyboard/touch/focus/aria-live/detail-panel requirements.

8. Recent change surface:
   - Added wakes/cargo/change markers based on existing supply delta and chain change fields.

9. Asset pipeline:
   - Added initial PNG/request budget, manifest required fields, production placeholder bans, alpha-trim/optimization, and actual-scale review.

10. Beta gate:
   - Added route unlinked/noindex gate until visual, accessibility, and performance gates pass.

## Remaining Implementation Cautions

- This is still a large feature. Implement Phase 1 as pure model code first and resist starting with sprite generation.
- Do not make new Worker endpoints until aggregate client-side payloads are proven insufficient.
- Do not expose Pixellab keys or generation URLs in client code.
- Do not let the page become a second dashboard table inside canvas; exact values belong in DOM.

## Final Readiness

After revisions, this pack is ready to guide implementation planning. It is not a single small ticket; it should be executed as phased work with explicit acceptance gates per document.

