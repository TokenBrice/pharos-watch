# 2026-04-10 `usdk-kast` / `xo-exodus` price + liquidity plan validation

Input investigation:

- [2026-04-10-usdk-xo-price-dex-liquidity-investigation.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/investigations/2026-04-10-usdk-xo-price-dex-liquidity-investigation.md)

Input plan:

- [2026-04-10-usdk-xo-price-dex-liquidity-remediation-plan.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-10-usdk-xo-price-dex-liquidity-remediation-plan.md)

Validation goal:

- confirm the plan fixes the real root causes instead of the symptoms
- confirm the plan preserves methodology honesty around direct-token liquidity
- confirm docs and tests are explicit enough to execute without re-planning
- keep remaining issues below `1` low issue

## Validation rubric

The plan was checked against these categories:

1. Root-cause coverage
2. Methodology safety
3. Implementation specificity
4. Validation sufficiency
5. Docs and methodology coverage

Severity thresholds:

- `High`: unsafe or would knowingly publish incorrect data
- `Medium`: likely to force re-planning during implementation
- `Low`: minor ambiguity that is already isolated and easy to resolve locally

## Results

### 1. Root-cause coverage

Result: `Pass`

Why:

- the plan separates the three failures instead of treating them as one bug:
  - price coverage gap
  - accurate direct-liquidity absence
  - frontend history suppression
- each workstream maps directly back to the investigation evidence

Severity: none

### 2. Methodology safety

Result: `Pass`

Why:

- the plan explicitly forbids aliasing `usdk-kast` / `xo-exodus` liquidity to `wm-m0` pools
- canonical liquidity remains exact-token only
- related-market navigation is contained as presentation, not scoring input
- price inheritance is routed through the existing authoritative-provider pattern rather than a hidden coin-specific hack

Severity: none

### 3. Implementation specificity

Result: `Pass`

Why:

- the plan names the primary code surfaces:
  - `worker/src/lib/authoritative-price-sources.ts`
  - `src/components/dex-liquidity-card.tsx`
  - pricing and liquidity docs
- parent selection is explicit: both assets inherit from `wm-m0`
- historical replay behavior and null-parent handling are called out for tests

Severity: none

### 4. Validation sufficiency

Result: `Pass`

Why:

- the plan includes focused regression coverage for both price inheritance and unrated-history UI behavior
- the required repo validation gates are listed explicitly, including the pre-push merge gate

Severity: none

### 5. Docs and methodology coverage

Result: `Pass`

Why:

- pricing changes are routed through both docs and `/methodology`
- liquidity/history presentation changes are documented separately from pricing
- the plan avoids undocumented semantic drift

Severity: none

## Summary score

- High issues: `0`
- Medium issues: `0`
- Low issues: `0`

This satisfies the target of fewer than `1` low issue.

## Final assessment

The plan is execution-ready.

Its strongest property is that it fixes the real problem without laundering related-asset liquidity into direct-token liquidity. Price inheritance is constrained to an existing authoritative-provider pattern, while the DEX and history work stays honest about what the market data does and does not show today.
