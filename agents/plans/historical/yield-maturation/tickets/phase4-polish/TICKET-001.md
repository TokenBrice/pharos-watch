---
title: "Remove experimental badge and update documentation"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Remove the experimental status from the yield page and update documentation to reflect the matured feature.

## Task

1. **Read `src/app/yield/page.tsx`** — Find the `statusBadge` prop on `FeaturePageShell`. It currently has `status: "experimental"`.

2. **Change the status to "mature":**
   - The `FeatureStatus` type (in `shared/lib/classification.ts`) has three values: `"mature" | "experimental" | "testing-in-prod"`
   - Change `status: "experimental"` to `status: "mature"` in the `statusBadge` prop
   - Do NOT remove the `statusBadge` prop entirely — the "Mature" badge is a positive signal

3. **Read `src/app/yield/client.tsx`** — Find and remove any "new feature" or "experimental" notice banner. Look for:
   - Amber/yellow colored banner components
   - Text containing "experimental", "new feature", "beta", or similar
   - Components like `Notice`, `Banner`, `Alert` used for feature announcements

4. **Update `docs/yield-intelligence.md`** — Add documentation for all new features:

   a. Under "## Database Schema" -> "### `yield_history`":
   - Add `warning_signals TEXT` to the column listing

   b. Under "## API Endpoints" -> "### `GET /api/yield-rankings`":
   - Add `medianApy: number` to the response shape

   c. Under "## API Endpoints" -> "### `GET /api/yield-history`":
   - Add `warningSignals: string[]` to the response data point shape

   d. Under "## Warning Signals":
   - Add `data-stale` signal to the table:
     ```
     | `data-stale` | `updated_at` > 90 min old | Yield data hasn't refreshed in 90+ min |
     ```

   e. Under "## Frontend":
   - Add `YieldHistoryChart` component documentation:
     ```
     ### `YieldHistoryChart` (`src/components/yield-history-chart.tsx`)
     Recharts line chart. Primary APY line with optional base/reward breakdown toggle. Two reference lines: T-bill rate and peer median APY. Warning signal markers on data points. Time presets: 7d / 30d / 90d / 1y.
     ```
   - Add `YieldDetailSection` component documentation:
     ```
     ### `YieldDetailSection` (`src/components/yield-detail-section.tsx`)
     Yield intelligence section for stablecoin detail pages. Shows stat cards (Current APY, 30d APY, PYS with breakdown, Stability, Excess Yield), source info, alt sources, warning callouts, and embedded YieldHistoryChart. Conditional: only renders for coins with yield data.
     ```
   - Update leaderboard documentation to mention tabs, filters, PYS tooltip, expandable rows
   - Add `useYieldHistory` to the hooks table

   f. Under "## File Index":
   - Add new files: `yield-history-chart.tsx`, `yield-detail-section.tsx`, `use-yield-history.ts`, the new migration file

5. **Verify no experimental markers remain:**
   ```bash
   grep -r "experimental" src/app/yield/
   ```
   This should return 0 results.

## Acceptance Criteria

- `npm run build` exits 0
- `grep -r "experimental" src/app/yield/` returns 0 results
- `grep -c "medianApy" docs/yield-intelligence.md` returns >= 1
- `grep -c "data-stale" docs/yield-intelligence.md` returns >= 1
- `grep -c "YieldHistoryChart" docs/yield-intelligence.md` returns >= 1
- `grep -c "YieldDetailSection" docs/yield-intelligence.md` returns >= 1
- `grep -c "useYieldHistory" docs/yield-intelligence.md` returns >= 1
