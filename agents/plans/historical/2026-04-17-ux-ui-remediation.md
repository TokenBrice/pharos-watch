# Pharos UX/UI Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Execute a comprehensive, surgical UX/UI remediation across Pharos — with maximum attention to the homepage (`/`) and the stablecoin detail page (`/stablecoin/[id]/`) — to sharpen new-user comprehension, accelerate power-user scanning, and tighten visual hierarchy without redesigning the brand or system.

**Architecture:** Touch only existing components and shared utility classes; preserve the design token system, typography stack, and dark-first aesthetic established in `docs/design-language.md` and `docs/design-context.md`. Changes are ordered by impact and dependency so each phase ships a coherent improvement.

**Tech Stack:** Next.js 16 (static export), Tailwind v4 via PostCSS, shadcn/ui primitives, Recharts, Playwright (visual verification), Vitest (unit).

**Source of truth:** This plan is derived from the audit captured in `agents/plans/2026-04-17-ux-ui-audit-findings.md` (see Appendix A below for a condensed findings index).

---

## Scope & Non-Goals

**In scope**
- Copy, label, and microcopy clarity
- Visual hierarchy, spacing, and grouping on the homepage and stablecoin detail page
- Scrollspy nav completeness and balance of the "Explore Next" hub
- Consolidating redundant safety-grade surfaces in the detail hero
- Command palette action surface, sidebar default group state, and a shared breadcrumb component
- Mobile polish (horizontal-scroll affordance, chip row alignment, tablet masthead gap)
- Editorial-vs-dashboard voice cohesion (Newsreader bleed)

**Out of scope** (do not touch in this plan)
- New features or data sources
- Methodology changes (PegScore, DEWS, PSI, LiquidityScore calculations)
- Shadcn primitives in `src/components/ui/**`
- Any `worker/`, `functions/`, `shared/lib/**` runtime logic
- The digest article aesthetic (Newsreader + Courier Italic) on `/digest/**` — that is an intentional exception
- The Cemetery (`/cemetery/`) aesthetic — also an intentional exception

---

## Guardrails

1. **Surgical changes only.** Every diff line must trace to a finding. Do not refactor adjacent code.
2. **Match existing style.** Use `pharos-*` utility classes before inventing new ones. No new colors or fonts; reuse semantic tokens.
3. **Static Tailwind strings only.** Never template class names.
4. **Preserve URL contract.** The homepage filter params (`q`, `peg`, `type`, `backing`, `grade`, `infrastructure`) MUST NOT change semantics.
5. **Preserve section IDs.** `LongformScrollspyNav` section ids are public via hash links. The real ids, verified against `src/app/stablecoin/[id]/client.tsx:86–94`, are: `report-card`, `overview`, `chart`, `liquidity`, `history`, and conditional `yield`. Labels shown in the pills are different from the ids: `{ id: "report-card", label: "Safety" }`, `{ id: "chart", label: "Market" }`. Additions are fine; renames are not.
6. **Backward-compatible D1 migrations.** This plan does not require migrations; if one is needed, it must be additive.
7. **Commit cadence.** One task = one commit. Commits reference the phase and task number.
8. **Verification before completion.** Every task ends with a run of the relevant check (lint / typecheck / test / playwright) and pastes the actual result.
9. **Accessibility preserved.** Every interactive change must keep `pharos-focus-ring`, keep ≥44px touch targets on mobile, and maintain a ≥4.5:1 contrast ratio in both themes.
10. **Do not delete existing code to "simplify" unless the change is the task.** Orphaned imports created by your change are fair game; other dead code is not.

---

## File Structure (high-level)

Files touched by this plan, grouped by phase. No new component files are created unless explicitly noted — most changes are in-place edits.

```
src/app/
  page.tsx                                   (Phase 2)
  layout.tsx                                 (Phase 8)

src/app/stablecoin/[id]/
  client.tsx                                 (Phase 5, 6)

src/components/
  site-header.tsx                            (Phase 2)
  kpi-bar.tsx                                (Phase 3)
  homepage-client.tsx                        (Phase 2, 4)
  homepage-sections.tsx                      (Phase 4)
  market-highlights.tsx                      (Phase 1)
  start-here-callout.tsx                     (Phase 1; locate by grep)
  sidebar.tsx                                (Phase 8)
  mobile-header.tsx / header.tsx             (Phase 9)
  command-palette.tsx                        (Phase 8)
  longform-scrollspy-nav.tsx                 (Phase 6)
  report-card.tsx                            (Phase 5)

src/components/stablecoin-detail/
  hero-card.tsx                              (Phase 5)
  explore-next-section.tsx                   (Phase 7)
  flows-section.tsx                          (Phase 5)

src/components/ui/
  breadcrumb.tsx                             (Phase 8, NEW — kept minimal, no shadcn override)
  — leave existing shadcn primitives alone —

src/lib/
  command-palette-actions.ts                 (Phase 8, NEW — small declarative actions list)

src/app/globals.css / src/styles/tokens/semantic.css  (Phase 10; additive only)

docs/design-language.md                      (Phase 12)
docs/homepage.md                             (Phase 12)
docs/start-page.md                           (verify; Phase 12)
```

---

## Phase Map

| Phase | Theme                                            | Est. tasks | Ship-gate                           |
|-------|--------------------------------------------------|------------|-------------------------------------|
| 0     | Preflight & baseline                             | 2          | Baseline screenshots captured       |
| 1     | Copy clarity (microcopy, labels, bps/turnover)   | 6          | Lint + visual diff                  |
| 2     | Homepage top-fold hierarchy                      | 5          | Lint + typecheck + playwright       |
| 3     | Market Snapshot labels + methodology tooltips    | 4          | Typecheck + a11y snapshot           |
| 4     | Homepage section transitions & density           | 5          | Visual verification + test          |
| 5     | Detail hero consolidation                        | 6          | Unit tests + visual verification    |
| 6     | Scrollspy nav completeness                       | 3          | Hash-link regression test           |
| 7     | Explore Next hub balance                         | 3          | Visual verification + build         |
| 8     | Global shell: breadcrumb + palette actions       | 5          | Unit tests + keyboard-nav check     |
| 9     | Mobile polish                                    | 5          | Playwright @ 390px + 820px          |
| 10    | Editorial / dashboard voice cohesion (docs + test)| 2          | Test + docs verification            |
| 11    | Accessibility & responsive verification          | 3          | Full a11y sweep + merge-gate        |
| 12    | Docs update                                      | 4          | `docs/design-language.md` current   |

**Total: ~48 tasks across 12 phases.**

---

## Phase 0 — Preflight & Baseline

### Task 0.1: Capture baseline visuals

**Files:**
- Create: `agents/plans/_ux-remediation-baseline/` — a committed directory of PNG baselines. These are intentionally checked in so reviewers can diff post-remediation screenshots against them. **Do not add this directory to `.gitignore`.** If the Playwright MCP default capture location is under an already-ignored path (e.g., `.playwright-mcp/`), `mv` the PNGs into the tracked directory before `git add`. The committed PNGs are a one-off baseline; they are not refreshed on every run.

- [ ] **Step 1:** From a shell, run a local dev server if needed (`npm run dev`), but for a baseline the public site is fine. Use the Playwright MCP tools in this exact sequence:

  ```
  mcp__plugin_playwright_playwright__browser_resize(1440, 900)
  mcp__plugin_playwright_playwright__browser_navigate("https://pharos.watch/")
  mcp__plugin_playwright_playwright__browser_wait_for(3)
  mcp__plugin_playwright_playwright__browser_take_screenshot(filename="baseline-home-1440-dark.png", fullPage=true)

  # Toggle light via the sidebar button (the button's accessible name flips; click it):
  mcp__plugin_playwright_playwright__browser_click(ref=<theme-toggle-ref from snapshot>)
  mcp__plugin_playwright_playwright__browser_take_screenshot(filename="baseline-home-1440-light.png", fullPage=true)

  mcp__plugin_playwright_playwright__browser_resize(820, 1000)
  mcp__plugin_playwright_playwright__browser_take_screenshot(filename="baseline-home-820-dark.png", fullPage=true)

  mcp__plugin_playwright_playwright__browser_resize(390, 844)
  mcp__plugin_playwright_playwright__browser_take_screenshot(filename="baseline-home-390-dark.png", fullPage=true)

  # Detail (pick a coin with full data)
  mcp__plugin_playwright_playwright__browser_resize(1440, 900)
  mcp__plugin_playwright_playwright__browser_navigate("https://pharos.watch/stablecoin/usdt-tether/")
  mcp__plugin_playwright_playwright__browser_wait_for(4)
  mcp__plugin_playwright_playwright__browser_take_screenshot(filename="baseline-usdt-1440-dark.png", fullPage=true)

  mcp__plugin_playwright_playwright__browser_resize(390, 844)
  mcp__plugin_playwright_playwright__browser_take_screenshot(filename="baseline-usdt-390-dark.png", fullPage=true)
  ```

  Move the PNGs from the default capture location (`/<cwd>/` or `.playwright-mcp/`) into `agents/plans/_ux-remediation-baseline/` before committing. Also capture `document.querySelector('header').innerText` and the detail hero's `innerText` via `mcp__plugin_playwright_playwright__browser_evaluate` for textual before/after diffing.

- [ ] **Step 2:** Commit baseline.

  ```bash
  git add agents/plans/_ux-remediation-baseline
  git commit -m "chore(ux): capture UX remediation baseline"
  ```

### Task 0.2: Confirm no open refactor in these files

- [ ] **Step 1:** `git log --since="30 days" --name-only --pretty=format: -- src/components/site-header.tsx src/components/kpi-bar.tsx src/components/stablecoin-detail/hero-card.tsx src/components/longform-scrollspy-nav.tsx src/components/command-palette.tsx` — skim for open refactors you would conflict with. If a teammate has a live branch on any of these, pause and coordinate before proceeding.

- [ ] **Step 2:** Run `npm run test:merge-gate` to confirm a clean baseline.

  Expected: PASS or "skipped cleanly (non-deploy-impacting diff)". If it fails, fix before starting Phase 1 — do not layer changes on a broken gate.

---

## Phase 1 — Copy clarity (microcopy, labels, units)

**Addresses findings:** H-03, H-07, H-16, D-09, D-13, G-11, G-12, G-13 (see Appendix A).

Low-effort, high-impact changes. Ship this phase first because clarity improvements compound with later hierarchy changes.

**Testing convention (applies to every copy-change task in this plan).** Several kickers and chip labels in the source are lowercase strings rendered uppercase via CSS (`uppercase` class or `tracking-[0.12em]` on a kicker). When asserting text in tests, use `toHaveTextContent(/bedrock/i)` (case-insensitive) or query by the source-case string — NOT by the CSS-rendered uppercase form. A `getByText("BEDROCK")` will fail even though the user sees "BEDROCK". The verbatim old/new strings in the tables below use the source case, and the CSS-rendering is preserved unchanged.

### Task 1.1: Replace abbreviations in homepage Market Snapshot supporting copy

**File:** `src/components/kpi-bar.tsx`

**Changes (verbatim copy, left → right):**

| Old                                  | New                                                                                |
|--------------------------------------|------------------------------------------------------------------------------------|
| `vs 7d avg +173.5%`                  | `vs 7d avg +173.5%` **keep value; change label tooltip to "24h DEX volume vs trailing 7-day average"** |
| `Turnover 2.51%`                     | `Turnover 2.51%` **keep; attach tooltip: "Daily DEX volume ÷ total tracked market cap"** |
| `7d total +$99.4M`                   | `7d net +$99.4M` (label: `7d net`, not `7d total` — we are showing net flow)       |
| `DEWS: Alert 5`                      | `DEWS 5 on alert` (kill colon; read as a count of coins)                           |
| `USDT+USDC share 79.7%`              | `USDT + USDC share 79.7%` (add spaces around `+`)                                  |
| `BEDROCK for 11d`                    | `BEDROCK · 11d in band` (the "for" reads as future; "in band" reads as duration)   |

- [ ] **Step 1:** Locate each string in `kpi-bar.tsx` (or its child components). For labels with methodology meaning, add a `MethodologyHint` trigger (existing component — see `docs/design-language.md` → "Contextual Explainability").
- [ ] **Step 2:** Write unit tests in `src/components/kpi-bar.test.tsx` (create if absent) asserting the exact rendered strings for `vs 7d avg`, `Turnover`, `7d net`, `DEWS`, `USDT + USDC share`, `BEDROCK · 11d in band`. Use React Testing Library queries already used elsewhere in the repo.
- [ ] **Step 3:** Run `npm test -- src/components/kpi-bar.test.tsx` — expect failures first (TDD).
- [ ] **Step 4:** Apply the edits.
- [ ] **Step 5:** Run tests again — expect PASS. Then `npm run lint`.
- [ ] **Step 6:** Commit: `refactor(homepage): clarify KPI bar copy and units`.

### Task 1.2: Clarify "Biggest Depegs / Biggest Supply Changes 7D"

**File:** `src/components/market-highlights.tsx`

Changes:
- Change `BIGGEST SUPPLY CHANGES 7D` → `BIGGEST 7-DAY SUPPLY MOVES` (reads left-to-right, no "D" abbreviation).
- Next to each depeg magnitude, keep the `bps` unit but add a tooltip via `MethodologyHint` on the section kicker: "bps = basis points. 100 bps = 1%. Values are the peak signed deviation from the target peg during the window."
- On the supply-mover side, add a single-line caption under the kicker: `Green = supply expansion; red = supply contraction (not price change).`

- [ ] **Step 1:** Write tests asserting kicker text and caption presence.
- [ ] **Step 2:** Apply changes.
- [ ] **Step 3:** Test + lint + commit: `refactor(homepage): clarify depeg/supply highlights copy`.

### Task 1.3: Clarify `PEG STATUS N/M` on homepage and detail

**File:** `src/components/kpi-bar.tsx` (and wherever detail hero surfaces this)

Change:
- Hover tooltip on the `PEG STATUS 137/147` cell reads: `Coins currently within peg band ÷ coins with a live peg check. DEWS risk counts shown below.`
- Add an inline `?` using `MethodologyHint` — do not add plain-text helper copy under the number (it would crowd the cell).

- [ ] **Step 1–3:** Same pattern as above. Commit: `refactor(homepage): add tooltip clarifying peg status ratio`.

### Task 1.4: Clarify `Bluechip: D ↗` on detail hero

**File:** `src/components/bluechip-header-badge.tsx`

- Wrap the single letter grade in a small accessible label: `Bluechip rating: D (via defiscore.io)`. The visual chip stays as-is; the screen-reader text expands, and a visible tooltip appears on hover/focus.
- Change the external arrow icon tooltip from default to: `View the external Bluechip methodology`.

- [ ] **Step 1:** Unit test for aria-label and visible tooltip text.
- [ ] **Step 2:** Apply edit.
- [ ] **Step 3:** Commit: `refactor(detail): annotate Bluechip rating badge`.

### Task 1.5: Clarify `DEWS Watch 18/100` on detail hero

**File:** `src/components/stablecoin-detail/hero-card.tsx`

Current: `DEWS  Watch  18/100`

Change to:
- Label stays `DEWS`
- The band label (`Watch`) is a small `Badge` with the band's semantic color token (`--dews-calm` → `--dews-danger`)
- The 18/100 keeps mono numeric rendering
- MethodologyHint tooltip next to `DEWS`: `DEWS (Depeg Early Warning System) band. 18/100 is the normalized stress score; the band labels the zone (Calm < Watch < Alert < Warning < Danger).`

- [ ] **Step 1–3:** TDD + commit: `refactor(detail): clarify DEWS signal chip`.

### Task 1.6: Clarify `BLACKLISTABLE Yes` on detail hero

**File:** `src/components/stablecoin-detail/hero-card.tsx`

- Change visible label to `FREEZABLE` (the industry term; "blacklistable" is Pharos-internal jargon).
- Keep the left accent border semantic class.
- MethodologyHint tooltip: `The issuer can freeze tokens in any wallet via on-contract admin functions. This is a trust/centralization risk, not an instant harm.`

- [ ] **Step 1:** Search `src/` for any test referencing `BLACKLISTABLE` and update expectations. Search `docs/methodology*.md` — do not rename the methodology page labels (those are canonical); only the detail hero chip label changes.
- [ ] **Step 2:** TDD + commit: `refactor(detail): relabel blacklistable chip as freezable`.

### Task 1.7: Verify no residual abbreviations on the homepage top fold

- [ ] **Step 1:** Grep the homepage tree for `\b(avg|vol|mcap)\b` in rendered strings (not variable names). Each visible instance must have either a full-word partner on the same line OR a methodology tooltip.
- [ ] **Step 2:** If gaps: file a patch and commit.

---

## Phase 2 — Homepage top-fold hierarchy

**Addresses findings:** H-01, H-02, H-04, H-05.

### Task 2.1: Elevate a single-sentence mission line on the desktop masthead

**File:** `src/components/site-header.tsx`

Current masthead tagline: `Peg stress, liquidity, safety, and dependency signals for every tracked stablecoin.`

Change:
- **New copy:** `Chart your route through the stablecoin market — live peg, safety, liquidity, and dependency signals on every tracked coin.` (aligns with the `/start/` page voice; stays informative).
- Render on `lg+` as a single line when it fits; clamp to 2 lines max on narrower `lg` widths via a `line-clamp-2` helper class.
- Keep the right-side stat pills unchanged in content; reduce their visual weight by 1 step (use `text-muted-foreground` for the number and `text-muted-foreground/70` for the unit).

- [ ] **Step 1:** Write a unit test asserting the new tagline string appears in the rendered masthead at `lg+`.
- [ ] **Step 2:** Apply change.
- [ ] **Step 3:** Verify no responsive breakage at 1024px, 1280px, 1440px, 1920px via Playwright.
- [ ] **Step 4:** Commit: `refactor(home): elevate masthead tagline; soften stat pills`.

### Task 2.2: Close the tablet masthead gap (768–1023 px)

**File:** `src/components/site-header.tsx`

Finding: The tagline is `hidden lg:flex` — at 820px users see only the wordmark and stat pills, which is less context than mobile.

Change:
- Move the tagline block from `lg:flex` to `md:flex`, wrapping to 2 lines at `md`–`lg` via `sm:line-clamp-2 lg:line-clamp-none`.
- Keep the mobile (`<md`) masthead card treatment unchanged.

- [ ] **Step 1:** Playwright test at 390px, 768px, 820px, 1024px, 1440px confirming the tagline visibility expectation.
- [ ] **Step 2:** Apply; commit: `fix(home): restore masthead tagline at tablet widths`.

### Task 2.3: Make the PSI lead card visually dominant in the snapshot row

**File:** `src/components/kpi-bar.tsx`

Finding: PSI already dominates via darker background, but the other 4 cells carry equal weight.

Change:
- Keep PSI's dominant cell as-is.
- Apply a visible weight step-down on the other four cells: primary number `text-2xl` (was `text-3xl`), label kicker size unchanged; keep mono.
- Replace the heavy `divide-x divide-border/50` with `divide-border/30` on `lg+` to soften the partitioning. On mobile, dividers remain where they are.
- Ensure the 5-cell row still aligns vertically at 1024px (PSI lead card is larger; other cells expand to fill row height via `items-stretch`).

- [ ] **Step 1:** Snapshot-test the rendered DOM at `lg` and `xl` via `@testing-library/react`.
- [ ] **Step 2:** Playwright verification at 1024, 1280, 1440, 1920.
- [ ] **Step 3:** Commit: `refactor(home): soften snapshot divider; step-down secondary KPI weight`.

### Task 2.4: Tighten the first-session "New to Pharos?" callout copy

**File:** `src/components/homepage-sections.tsx` (component is `StartHereCallout`, lines 8–50; the file also exports `HomepageSectionBand`).

Change copy body from (verbatim current source, lines 25–27):
> The /start/ page explains what the core signals mean and points you to the right surface for market monitoring, single-coin research, yield, comparison, or alerts.

To:
> The Start page takes 2 minutes and routes you to the right surface for what you need: market monitoring, single-coin research, yield, comparison, or alerts.

- Shorter, active-voice, explicit time-to-read cue.
- Keep CTA buttons unchanged.
- Do **not** rewrite the heading on line 22 — that's task 2.1's territory and must stay consistent with the /start/ editorial voice.

- [ ] **Step 1:** Unit test asserting the new string via `toHaveTextContent`.
- [ ] **Step 2:** Apply; commit: `refactor(home): tighten first-session onboarding copy`.

### Task 2.5: Reorder tablet/mobile above-the-fold for onboarding-first

**File:** `src/components/homepage-client.tsx`

Current order (mobile + tablet, first session): Masthead → Market Snapshot → Start Here callout.

Finding: A first-session user lands on the dense Market Snapshot before seeing the Start Here callout. On mobile this pushes the callout below the fold.

Change (first session only):
- Order on `<lg`: Masthead → Start Here callout → Market Snapshot.
- Order on `lg+`: unchanged (Snapshot sits immediately below the masthead because it's the quickest read for returning users).

Use the existing gate already wired at line 91 — `const { isReady: startHereReady, shouldShow: shouldShowStartHereCallout, retireCallout } = useStartHereCallout();` — and its render at line 177 (`{startHereReady && shouldShowStartHereCallout ? <StartHereCallout … /> : null}`). Move the `<StartHereCallout />` render node above `<KpiBar />` at `<lg` widths; keep its current position at `lg+`. Do **not** introduce a new context provider and do **not** rename the hook's returned fields.

A CSS-only reorder is preferable to a JS branch — wrap both blocks in a `flex flex-col` container and use `order-1 lg:order-2` on the callout and `order-2 lg:order-1` on the KPI bar wrapper. Keep the rest of the section array intact.

- [ ] **Step 1:** Render test at 390px with the gate open asserts the Start Here callout's `order` computed-style is before the KPI bar's.
- [ ] **Step 2:** Render test at 1440px asserts the KPI bar's `order` computed-style is before the callout's.
- [ ] **Step 3:** Apply; commit: `fix(home): place Start Here callout above Market Snapshot on mobile first session`.

---

## Phase 3 — Market Snapshot labels + methodology tooltips

**Addresses findings:** H-03, H-11, H-17.

### Task 3.1: Add MethodologyHint triggers to the four secondary snapshot cells

**File:** `src/components/kpi-bar.tsx`

Each of `Total Stablecoin Mcap`, `Peg Status`, `Tracked 24h DEX Vol`, `Net Mint/Burn Flow` gets a `?` methodology hint trigger on its kicker. Content (final copy):

- `Total Stablecoin Mcap` → "Sum of circulating supply × peg-reference price across all tracked coins. Updates every 15 min."
- `Peg Status` → "Coins currently inside the peg band ÷ coins with a live peg check. DEWS counts highlight coins on alert."
- `Tracked 24h DEX Vol` → "Sum of AMM volume across tracked coins, restricted to the pool set Pharos coverages for liquidity scoring."
- `Net Mint/Burn Flow` → "Net on-chain mint/burn across tracked coins in the last 24h. Positive = expansion. Excludes atomic round-trips."

- [ ] **Step 1:** Unit tests asserting the tooltip text per trigger.
- [ ] **Step 2:** Apply; commit: `feat(home): add methodology hints to market snapshot cells`.

### Task 3.2: Unify mobile vs. desktop PSI delta display

**File:** `src/components/kpi-bar.tsx`

Finding H-17: Mobile PSI card shows 24h/7d/30d deltas that desktop hides.

Decide + apply: **Surface the three PSI deltas on all breakpoints** as compact pills below `BEDROCK · 11d in band`. This preserves the richer context the mobile card already shows, and the vertical space cost on desktop is small.

Rationale: a power user glancing at the homepage should see directional momentum at-a-glance; hiding it on desktop is an accidental carve-out, not an intent.

- [ ] **Step 1:** Render test at 390, 1024, 1440 asserting the 24h/7d/30d pills exist.
- [ ] **Step 2:** Confirm PSI score/band lockup is not pushed below the fold on `lg`–`1599px` (the docs call this band out). If pushed, move the delta pills to the right side of the PSI cell instead of below.
- [ ] **Step 3:** Commit: `feat(home): expose PSI deltas on all breakpoints`.

### Task 3.3: Verify DEWS cell signals severity visually

**File:** `src/components/kpi-bar.tsx`

Ensure the `DEWS 5 on alert` pill uses `--dews-alert` / `--dews-warning` semantic color tokens depending on the count, not a fixed color. Tokens already exist in `semantic.css`.

- [ ] **Step 1:** Unit test with mocked counts (0, 1, 5, 12) asserting the right semantic token class applies.
- [ ] **Step 2:** Apply; commit: `refactor(home): drive DEWS pill color from semantic tokens`.

### Task 3.4: Add a single-line "last refresh" line beneath the snapshot

**File:** `src/components/kpi-bar.tsx`

Currently: `Refreshes every 15m` sits top-right of the Market Snapshot card.

Change: Add a second line under the card (not inside): `Last refreshed · <relative time> · <absolute timestamp>`. Reuse the existing `StaleDataBanner`/`useDataHealth` wiring or `X-Data-Age` header already exposed by `/api/stablecoins`.

- [ ] **Step 1:** Unit test with mocked data-age header.
- [ ] **Step 2:** Apply; commit: `feat(home): surface last-refresh timestamp below market snapshot`.

---

## Phase 4 — Homepage section transitions & density

**Addresses findings:** H-06, H-08, H-09, H-10, H-13.

### Task 4.1: Strengthen zone-band visual differentiation

**File:** `src/components/homepage-sections.tsx`, `src/app/globals.css`

Finding: `--surface-zone-monitoring` and `--surface-zone-research` changes are subtle in dark mode.

Change:
- Bump the zone-band background contrast by ~3% oklch in dark mode (additive, behind the current value).
- Add a `--zone-header-accent` thin rule (1px) above the kicker in the zone section header.
- Keep light mode untouched (already clear on white).

- [ ] **Step 1:** Playwright A/B at 1440x900 dark to confirm perceptible but not heavy separation.
- [ ] **Step 2:** Commit: `refactor(home): strengthen zone-band separation in dark mode`.

### Task 4.2: Add `space-y-8` between the PegBrowseStrip and the StablecoinTable

**File:** `src/components/homepage-sections.tsx` (Key Stablecoin Data region)

Finding H-08: visually the strip and the table run together.

Change: Nudge the gap between the two to `space-y-8` (from `space-y-6`); keep the filter chip row adjacent to the table (no extra gap there).

- [ ] **Step 1:** Visual diff before/after at 1440.
- [ ] **Step 2:** Commit: `fix(home): increase rhythm between peg strip and table`.

### Task 4.3: Introduce a small "why am I seeing this?" caption under the Daily Digest preview

**File:** `src/components/homepage-sections.tsx` (DailyDigest preview mount)

Change: Under the Digest's preview headline, add a single `pharos-meta`-sized line: `A short editorial summary Pharos publishes daily on the state of the market.` — this orients a first-time visitor who doesn't know what the Digest is.

- [ ] **Step 1:** Unit test for the caption.
- [ ] **Step 2:** Apply; commit: `feat(home): orient first-time visitors to the Daily Digest`.

### Task 4.4: Reframe "Upcoming Stablecoins" header

**File:** `src/components/homepage-sections.tsx` (upcoming region)

Current header: `UPCOMING STABLECOINS / 10 stablecoins on the horizon / Pre-launch projects tracked by Pharos. Hover a coin for details…`

Change:
- Kicker: `WATCHLIST · PRE-LAUNCH` (short, grounds the user)
- Title: `10 coins to watch before they ship`
- Caption: Condense to: `Hover for details. Open a profile for the exact Telegram launch-alert command.`
- Keep the Launch-alerts and View-all links; do not change their destinations.

- [ ] **Step 1:** Test asserting the strings.
- [ ] **Step 2:** Apply; commit: `refactor(home): tighten upcoming-stablecoins header`.

### Task 4.5: Compact the Research Surfaces band

**File:** `src/components/homepage-client.tsx` (Research Surfaces group)

Finding H-13: 4 full-width sections stacked feels repetitive.

Change:
- Group `TotalMcapChart` (full-width) above a 2-column grid at `lg+` containing `PegDiversityChart` and `NonUsdShareChart` side-by-side.
- `CategoryStats` stays full-width above the pair.
- Preserve all per-section error boundaries.

- [ ] **Step 1:** Snapshot test at 1024 and 1440.
- [ ] **Step 2:** Mobile should stay linear (stacked); confirm at 390.
- [ ] **Step 3:** Commit: `refactor(home): compact research surfaces into 2-col grid at lg+`.

---

## Phase 5 — Detail hero consolidation

**Addresses findings:** D-01, D-02, D-03, D-04, D-12.

### Task 5.1: Remove the redundant right-side "Safety Grade" badge on the detail hero

**File:** `src/components/stablecoin-detail/hero-card.tsx`

Finding D-01: The hero's right-side `Safety Grade` badge duplicates the Safety Score card immediately below it. The component renders `SafetyGradeHero` in two places: mobile (~line 564) and the desktop right column (~line 725). Confirm exact line numbers before editing.

Change:
- **Desktop** (`lg+`): drop the right-column `SafetyGradeHero` render.
- **Mobile** (`<lg`): keep `SafetyGradeHero` — on a narrow screen the Safety Score card below is far enough down the scroll that the mobile anchor is genuinely useful. Do **not** delete the mobile render.
- **Desktop replacement**: render a compact `HeroSignalsRail` in the slot vacated by the badge, containing four pills: `Safety B · 71/100`, `Peg A+ · 99`, `Liquidity C · 62`, `DEWS Watch · 18`. Each pill is an anchor link. **Anchor IDs (verified against `src/app/stablecoin/[id]/client.tsx` lines 258, 274, 314, 326):**
  - Safety → `#report-card` (the Safety Score card's existing id — **not `#safety`**; the Safety pill in the scrollspy nav already points here)
  - Peg → `#report-card` (jumps to Safety Score card; the Peg dimension is there)
  - Liquidity → `#liquidity`
  - DEWS → `#report-card` (same Safety Score card — DEWS is a dimension inside it)

The scrollspy nav's pill labelled "Safety" already routes to `#report-card`, so the rail is consistent with it. If a future refactor renames that id to `#safety`, update both surfaces in the same commit.
- Keep the numeric rendering in `font-mono tabular-nums`. Use the existing `pharos-focus-ring` utility.
- The first rail item (Safety) is the heaviest weight; peers step down to `text-muted-foreground` for the grade letter.

- [ ] **Step 1:** Write a unit test asserting the rail renders four pills in order and each has the correct `href="#..."`. Also assert mobile still renders `SafetyGradeHero` and desktop does not.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Playwright: visit `/stablecoin/usdt-tether/`, click each rail pill at 1440px, assert the URL hash changes and the targeted element (`document.getElementById("report-card")` or `document.getElementById("liquidity")`) is in-view (i.e., `getBoundingClientRect().top` is near the rail's scroll offset).
- [ ] **Step 4:** Commit: `refactor(detail): replace desktop hero safety badge with signals rail`.

### Task 5.2: Order the hero signal chip row by severity

**File:** `src/components/stablecoin-detail/hero-card.tsx`

Currently: `PEG | LIQ | BLACKLISTABLE | EXCESS YIELD | DEWS | CHAINS`.

Change to severity-ordered: `DEWS | FREEZABLE | PEG | LIQ | EXCESS YIELD | CHAINS`. Risk and warning signals come first; neutral/count signals last. The `FREEZABLE` chip's left accent border (semantic amber) becomes more meaningful when placed after DEWS.

- [ ] **Step 1:** Unit test asserts the rendered order.
- [ ] **Step 2:** Apply; commit: `refactor(detail): severity-order hero signal chips`.

### Task 5.3: Normalize empty states in the hero chip row

**File:** `src/components/stablecoin-detail/hero-card.tsx`

Finding D-13: some chips show `—` and others render empty when data is missing, making rows uneven on mobile.

Change: A single `<ChipValue value={...} fallback="—" />` pattern; when value is null, render `—` with a muted class and an `aria-label="Data unavailable"`. Ensure every chip has equal height via flex.

- [ ] **Step 1:** Storybook-style test with null props asserting dash renders consistently.
- [ ] **Step 2:** Apply; commit: `fix(detail): normalize empty-state rendering in hero signal chips`.

### Task 5.4: Clean the Mint & Burn Flows empty-state layout

**File:** `src/components/flow-summary-card.tsx` (the real home of the 30d/90d tiles and the pressure gauge — see lines 310 and 323 for the `Net 30d` / `Net 90d` rendering). The wrapper `src/components/stablecoin-detail/flows-section.tsx` is only ~35 lines and should not be edited.

Finding D-12: The "No activity" empty state renders 4 repeated `Net 30d` / `Net 90d` tiles, and a second pressure gauge appears below an empty gauge. Verify the exact DOM against the live site at `/stablecoin/usdt-tether/` before editing, since the duplicated tiles are conditional on a specific combination of flow metadata states.

Change: If the card resolves to a no-activity state (no mint/burn events in the 24h window AND no coin-level pressure shift), collapse to a single card with:
- The Flow Desk illustration (keep — distinctive, part of the brand voice).
- One-sentence copy: `No mint or burn events recorded in the last 24h. Longer-window historical flows are below.`
- Below the card, render ONE row of `Net 30d` / `Net 90d` tiles (not two).

- [ ] **Step 1:** Read `flow-summary-card.tsx` end-to-end and map every branch that renders a `Net 30d` or `Net 90d` tile. Document the branches in a short comment above the PR description; do not collapse branches that render different data.
- [ ] **Step 2:** Add a Vitest case in `src/components/__tests__/flow-table.test.tsx` (or a new `src/components/__tests__/flow-summary-card.test.tsx`) with a no-activity fixture; assert exactly one `Net 30d` tile and one `Net 90d` tile render.
- [ ] **Step 3:** Apply; commit: `fix(detail): collapse repeated empty-state tiles in flow summary card`.

### Task 5.5: Attach `Compare vs <peer>` label to make the default peer choice legible

**File:** `src/app/stablecoin/[id]/client.tsx` (top-right actions in the detail hero)

Currently: `Compare vs USDC` is hard-coded.

Change: Generate the label from the primary peer computed in `getPrimaryStaticComparisonPageForCoin(coin.id)` — the exported helper takes a `coinId: string`, not the full `coin` object (signature: `src/lib/compare-pages.ts:120`; the existing callsite in `hero-card.tsx:296` already passes `coin.id`). If the helper returns `null`, fall back to the label `Compare`. Add a title attribute: `Compare Tether against its default peer, USD Coin` (or equivalent, derived from the returned `StaticComparisonPage`).

- [ ] **Step 1:** Unit test with different `coin` fixtures to assert the generated label.
- [ ] **Step 2:** Apply; commit: `refactor(detail): derive compare-vs-peer label from primary peer`.

### Task 5.6: Strengthen the detail hero classification line

**File:** `src/components/stablecoin-detail/hero-card.tsx`

Current: `Centralized (CeFi) · Real-World Asset Backed · US Dollar` in small gray below the name.

Change: Move this into a dedicated row with small pill-shaped links that each route to the relevant taxonomy page. **Use the exported URL builders; do not hand-write slugs:**
- Governance pill → `buildGovernanceTaxonomyUrl(coin.flags.governance)` → e.g., `centralized` resolves to `/stablecoins/governance/cefi/` (source: `src/lib/stablecoin-taxonomy.ts:201–203`).
- Backing pill → `buildBackingTaxonomyUrl(coin.flags.backing)` → e.g., `rwa-backed` resolves to `/stablecoins/backing/rwa/` (same file, lines 205–207).
- Peg pill → uses the peg slug map, which IS exported: `PEG_SLUGS` from `src/lib/peg-landing.ts:46`. `PEG_SLUGS` is typed `Partial<Record<PegCurrency, string>>` — guard with a nullish check so a coin whose peg is not in `ACTIVE_PEGS` does not blow up. If the slug is missing, omit the peg pill entirely.

```ts
const pegSlug = PEG_SLUGS[coin.flags.pegCurrency];
const pegHref = pegSlug ? `/stablecoins/${pegSlug}/` : null;
```

**Field names on `StablecoinMeta.flags`:** `governance`, `backing`, `pegCurrency` — verified against `src/components/stablecoin-detail/hero-card.tsx:216, 218, 220`. Do NOT use `governanceType` / `backingType` — those do not exist.

**Labels:** Use `GOVERNANCE_LABELS`, `BACKING_LABELS`, `PEG_LABELS_SHORT` from `@shared/lib/classification` — all three are exported there. Do not redefine labels locally.

No handwritten hrefs; no invention of new slug strings.

- [ ] **Step 1:** Unit test asserting three links are rendered with the exact hrefs produced by the slug maps for a few coin fixtures (centralized/rwa/usd and a decentralized/crypto/eur case).
- [ ] **Step 2:** Apply; commit: `refactor(detail): turn classification line into taxonomy pills`.

---

## Phase 6 — Scrollspy nav completeness

**Addresses findings:** D-05, D-06.

### Task 6.1: Add missing scrollspy targets

**File:** `src/components/longform-scrollspy-nav.tsx` (no change here — this is purely a consumer of the `sections` array) and `src/app/stablecoin/[id]/client.tsx` (the parent that both renders the section elements with `id=...` attributes AND passes the `sections` array to the nav).

Current pills (and their existing anchor ids in the client — see `src/app/stablecoin/[id]/client.tsx:86–94`): `Safety → #report-card`, `Overview → #overview`, `Market → #chart`, `Liquidity → #liquidity`, `History → #history` (+ optional `Yield → #yield`). Note the `Market` pill's id is `#chart`, not `#market`. Verify with `grep -n 'BASE_DETAIL_SECTIONS\\|id="' src/app/stablecoin/[id]/client.tsx` before editing.

Add (conditional on section presence):
- `Flows → #flows` when the coin has flow data. **Prerequisite:** `flows-section.tsx:18` already renders `<section id="flows">`. No section-element change needed.
- `Reserves → #reserves` when a reserve treemap renders. **Prerequisite:** no `id="reserves"` exists today. Before adding the pill, wrap the reserve treemap in a `<section id="reserves">` inside `src/components/stablecoin-detail/overview-section.tsx` (or wherever the treemap mounts).
- `Explore → #explore-next` — always present as a terminal pill. **Prerequisite:** no `id="explore-next"` exists today. Before adding the pill, wrap the `<ExploreNextSection />` render in the client with `<section id="explore-next">…</section>`, or add the id to the existing top-level element inside `explore-next-section.tsx`.

**Do not rename** existing pills — their hash anchors are public. In particular, keep `Safety → #report-card` as-is.

- [ ] **Step 1:** Add the two missing `id=...` attributes (Reserves + Explore) to the client render. Confirm every pill-target anchor now resolves to a real DOM node.
- [ ] **Step 2:** Unit test the `sections` array construction under four data shapes (full / no-yield / no-flows / no-reserves).
- [ ] **Step 3:** Implement; verify the scrollspy underline correctly tracks the new sections (play with scroll position in Playwright and assert the active pill).
- [ ] **Step 4:** Regression test: existing `#report-card`, `#overview`, `#chart`, `#liquidity`, `#history` hashes still scroll to the right target.
- [ ] **Step 5:** Commit: `feat(detail): complete scrollspy nav coverage`.

### Task 6.2: Split "Overview" into two pills: `Overview` and `Price`

**File:** same as above + hero overview region

Finding D-06: `Overview` covers AI summary + Price Transparency + DEWS detail + Reserve Treemap + notices — too much behind one pill.

Change (anchor-stable strategy — no hash aliasing):
- **Keep the existing `#overview` anchor** as the id of the first (Context) group. This preserves all inbound links and the scrollspy's self-written hash without any `replaceState` dance.
- Add a new `#price` anchor for the second group.
- Group 1 (`id="overview"`, pill label `Overview`): AI summary + notices + DEWS detail + collateral usage.
- Group 2 (`id="price"`, pill label `Price`): Price Transparency card + Redemption Backstop.
- Do **not** introduce a `useEffect` that rewrites the hash on mount — that would fight `LongformScrollspyNav`'s scroll-sync logic (`scheduleSectionAlignment` in `src/components/longform-scrollspy-nav.tsx:47`).

- [ ] **Step 1:** Unit test asserting both `#overview` and `#price` section nodes exist in the DOM and the scrollspy pill array contains both, in order.
- [ ] **Step 2:** Playwright regression: load `/stablecoin/usdt-tether/#overview`, assert `getBoundingClientRect().top` of `#overview` is near 0 (within scroll offset).
- [ ] **Step 3:** Implement and commit: `refactor(detail): split overview scrollspy into overview and price`.

### Task 6.3: Mobile sticky nav — visible scroll affordance

**File:** `src/components/longform-scrollspy-nav.tsx`

Finding: mobile scroll nav's native scroll bar is visible; we already show a depth-hint gradient below the rail. Add a right-edge fade mask so the right-overflowed pills look clipped on purpose, not broken.

- [ ] **Step 1:** Visual at 390 before/after.
- [ ] **Step 2:** Commit: `polish(detail): add right-edge fade mask to mobile scrollspy rail`.

---

## Phase 7 — Explore Next hub balance

**Addresses findings:** D-08, D-09.

### Task 7.1: Fix the left/right column height imbalance

**File:** `src/components/stablecoin-detail/explore-next-section.tsx`

Current: Left (Taxonomy + Trackers) short; right (Compare + Related) long.

Change (desktop only):
- Reflow into a three-column grid at `xl+`: `Taxonomy | Trackers | Compare + Related`.
- At `lg`: two columns, Taxonomy+Trackers on the left, Compare+Related on the right.
- At `<lg`: stacked, in this order: Compare → Taxonomy → Trackers → Related.

- [ ] **Step 1:** Visual verification at 1024, 1280, 1440.
- [ ] **Step 2:** Commit: `refactor(detail): rebalance explore-next hub`.

### Task 7.2: Clarify "Review brief" vs "Open live compare"

**File:** `src/components/stablecoin-detail/explore-next-section.tsx`

Current: each compare pair shows two buttons — unclear distinction.

Change:
- Primary button: `Open comparison →` (routes to `/compare/<slug>/` — the live compare view).
- Secondary text link beneath: `Read the one-page brief` (routes to the static comparison page).
- The primary affordance is the live view; the brief is a reference read. Reverse the current hierarchy.

- [ ] **Step 1:** Unit test asserting the primary button text and the secondary link.
- [ ] **Step 2:** Apply; commit: `refactor(detail): clarify compare affordance hierarchy`.

### Task 7.3: Cap the Related Stablecoins pills

**File:** `src/components/stablecoin-detail/explore-next-section.tsx`

Current: up to 5 pills; layout scales but looks noisy when 3 pills wrap awkwardly.

Change: cap at 4 pills; add a terminal `See all peers →` link that routes to the coin's taxonomy page.

- [ ] **Step 1:** Test with 3 / 4 / 7 related coins; assert pills cap at 4 + see-all link.
- [ ] **Step 2:** Apply; commit: `polish(detail): cap related-stablecoins pills at 4`.

---

## Phase 8 — Global shell: breadcrumb + palette actions

**Addresses findings:** G-01, G-02, G-03, G-04.

### Task 8.1: Create a shared `<Breadcrumb />` component

**Files:**
- Create: `src/components/breadcrumb.tsx`
- Test: `src/components/breadcrumb.test.tsx`

Contract:
- Props: `items: { label: string; href?: string }[]`
- Renders a `<nav aria-label="Breadcrumb">` with a `<ol>` of items separated by a `/` divider (copy divider, not icon).
- Each item is a link unless it's the last (current page) which is plain text with `aria-current="page"`.
- Typography matches the existing inline breadcrumb class: `flex items-center gap-1.5 text-xs text-muted-foreground sm:text-sm`.

- [ ] **Step 1:** Write tests for 1, 2, 3-item cases, aria-current, focus ring.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Migrate the ad-hoc `Dashboard / Tether` string in `src/components/stablecoin-detail/hero-card.tsx` to use this component.
- [ ] **Step 4:** Commit: `feat(shell): add shared breadcrumb component; migrate detail hero`.

### Task 8.2: Render the breadcrumb above the hero on deep routes

**Files:**
- `src/app/stablecoin/[id]/client.tsx`
- `src/app/stablecoins/[peg]/**/*.tsx` (peg landing pages)
- `src/app/chains/[chain]/**/*.tsx` (chain pages)

Change: Render the new `<Breadcrumb />` above the hero card on every deep route. On the homepage (`/`), no breadcrumb. On the start page (`/start/`), breadcrumb is `Dashboard / Start Here` (already present inline — migrate to the shared component).

- [ ] **Step 1:** Test each migrated route renders one breadcrumb, not two.
- [ ] **Step 2:** Commit per-route or in one commit: `feat(shell): render breadcrumb on deep routes`.

### Task 8.3: Expand command-palette actions beyond theme toggle

**Files:**
- Create: `src/lib/command-palette-actions.ts` (declarative action list)
- Modify: `src/components/command-palette.tsx`

Actions to add:
- `Switch to light mode` / `Switch to dark mode` (keep existing)
- `Open feedback form` (dispatches existing feedback open event)
- `Copy current URL` (uses `navigator.clipboard.writeText(window.location.href)`)
- `Open methodology` (navigates to `/methodology/`)
- `Open API docs` (navigates to `/about/api/`)
- `Open today's digest` (navigates to `/digest/`)
- `Reset homepage filters` (only on `/`; calls `clearAll()` exported from `src/hooks/use-homepage-filters.ts:97`. The action's `onSelect` must import and invoke the hook via a small adapter at action-mount time — since a palette action cannot call hooks directly, pass a callback down from the home page's client via the existing palette custom-event pattern, or gate the action's visibility by `pathname === "/"` and use a DOM event to delegate the call back to `HomepageClient`.)

Each action has a keyword list, an icon, a short description, and an `onSelect` callback.

- [ ] **Step 1:** Write tests per-action: action resolution, fuzzy match on label and keywords, selection fires the callback.
- [ ] **Step 2:** Wire actions through existing keyboard-nav and selection model (no new state machine).
- [ ] **Step 3:** Commit: `feat(shell): expand command palette actions`.

### Task 8.4: Default the `data` (TRACK) sidebar group to expanded

**File:** `src/lib/nav-config.ts` (where `DEFAULT_EXPANDED` is declared at line 97).

Finding G-04: All three groups default collapsed. The `data` group (displayed as `TRACK`) is the highest-traffic data layer; burying it by default hurts discoverability.

Change:
- `DEFAULT_EXPANDED` current value: `{ data: false, tools: false, info: false }`.
- New value: `{ data: true, tools: false, info: false }`.
- Keys are the lowercase `NavGroup.key` values (`data`, `tools`, `info`), NOT the uppercase display labels (`TRACK`, `Analyze`, `Reference`).
- Persist the user's choice in `localStorage` as before; this only changes the initial state for a user with no stored preference. Confirm the persistence layer honors the `key`, not the `label`.

- [ ] **Step 1:** Unit test: render the sidebar with an empty `localStorage` and assert the TRACK group (identified by its display label) is expanded on first render.
- [ ] **Step 2:** Unit test: render with a stored `{ data: false }` preference and assert the group is collapsed.
- [ ] **Step 3:** Commit: `refactor(shell): expand TRACK (data) sidebar group by default`.

### Task 8.5: Move "Telegram" out of the primary sidebar items into TRACK

**File:** `src/lib/nav-config.ts` (only this file — the sidebar component reads from the exported arrays).

Finding G-03: Telegram is a single-purpose alerts route — odd as a peer to Dashboard / Stability Index. In the current source, `PRIMARY_NAV_ITEMS` (line 51) holds five items: Dashboard, Stability Index, Safety Scores, Risk-Adjusted Yield, Telegram. `NAV_GROUPS[0]` is the `data` group with display label `TRACK` (line 59) and contains seven items.

Change:
- Remove the `{ href: "/telegram", … }` entry from `PRIMARY_NAV_ITEMS`. It leaves four items there.
- Append the same nav-item object to `NAV_GROUPS[0].items` (the `data` group, displayed as TRACK), placed after `Upcoming` and before `Cemetery` — both are "stay informed" features.
- The flat `NAV_ITEMS` at line 109 is derived (`[...PRIMARY_NAV_ITEMS, ...NAV_GROUPS.flatMap(...), ...BOTTOM_NAV_ITEMS]`) and does not need editing. Confirm.
- Preserve the URL (`/telegram`) and the label (`"Telegram"`); only the group placement changes.

- [ ] **Step 1:** Grep for callers of `PRIMARY_NAV_ITEMS`, `NAV_GROUPS`, and `NAV_ITEMS` (command palette uses all three via the `ALL_PAGES` spread in `src/components/command-palette.tsx:39`). Confirm no caller depends on Telegram's index in `PRIMARY_NAV_ITEMS`.
- [ ] **Step 2:** Unit test: the flat `NAV_ITEMS` still contains the Telegram entry exactly once.
- [ ] **Step 3:** Commit: `refactor(shell): relocate Telegram from primary nav into TRACK group`.

---

## Phase 9 — Mobile polish

**Addresses findings:** H-15, H-16, D-13, G-08, G-09.

### Task 9.1: Mobile horizontal-scroll affordance on the stablecoin table

**File:** `src/components/stablecoin-table.tsx` (or wherever the table shell wraps on mobile)

Change: Add a right-edge mask-image gradient fade over the last 24px on `sm` and below. Also add a one-time inline helper caption above the table on first render: `Swipe to see more columns →`, dismissible after first scroll via sessionStorage flag.

- [ ] **Step 1:** Playwright at 390 verifies the gradient mask and the caption.
- [ ] **Step 2:** Commit: `polish(home): mobile horizontal-scroll affordance on stablecoin table`.

### Task 9.2: Mobile header — replace redundant wordmark with tagline

**File:** `src/components/header.tsx` (mobile header)

Finding H-16: Mobile header and the masthead card below both show `PHAROS`.

Change: the mobile sticky header keeps the shield logo + hamburger, and shows a 1-line compact tagline in the middle slot: `live stablecoin signals`. Mono lowercase, tight tracking, muted color. The masthead card below retains the full wordmark.

- [ ] **Step 1:** Test asserts the tagline text at `<md`.
- [ ] **Step 2:** Commit: `polish(shell): differentiate mobile header from masthead`.

### Task 9.3: Radar chart mobile axis labels

**File:** `src/components/report-card.tsx` (radar chart axis labels).

Finding G-09: The mobile axis label `Decen.` is opaque.

**Constraint (locked after review):** The canonical dimension name is `Decentralization` — the API field is `decentralization`, `dimKey === "decentralization"` in this same file at lines 96 and 161, `docs/report-cards.md` and `docs/api-reference.md` both use the full name. Do **not** rename the dimension or introduce a "Governance" alias; that would fork Pharos's public methodology vocabulary.

Change (label-only, no dimension rename):
- At `<sm`: `Peg | Exit | Resil. | Decent. | Dep.` (add trailing periods for readability; "Decent." is slightly less ambiguous than "Decen.")
- At `sm+`: `Peg Stability | Exit Liquidity | Resilience | Decentralization | Dependency` (full words).
- Dimension keys, scores, and any exports remain untouched.

- [ ] **Step 1:** Unit test asserting the rendered labels at mobile and desktop widths.
- [ ] **Step 2:** Apply the minimal label change.
- [ ] **Step 3:** Commit: `polish(detail): tighten mobile radar chart axis labels`.

### Task 9.4: Mobile utility dock — confirm it doesn't overlap the tableau last row

**File:** `src/components/mobile-utility-dock.tsx`, `src/app/globals.css` (`--mobile-utility-safe-offset`)

Change: no code change if the dock is already honoring the safe-offset. Instead, verify via Playwright at 390 that the last row of the stablecoin table is never covered by the dock when scrolled to the bottom.

- [ ] **Step 1:** Playwright assertion.
- [ ] **Step 2:** If broken: bump `--mobile-utility-safe-offset` by `var(--spacing)` and retest.
- [ ] **Step 3:** Commit only if changes: `fix(mobile): ensure utility dock respects safe-offset on long pages`.

### Task 9.5: Stale-data banner verbosity on mobile

**File:** `src/components/stale-data-banner.tsx` (or `QueryErrorNotice.tsx`)

Finding D-14: Banner repeats dataset names.

Change: Banner copy pattern becomes: `<Title>. Affected: <datasets>. Last successful update: <timestamp>.` — remove the second redundant dataset mention. At `<sm`, truncate to: `<Title> · Last update <time>`.

- [ ] **Step 1:** Test fixtures at both widths.
- [ ] **Step 2:** Commit: `refactor(shell): de-duplicate stale-data banner copy`.

---

## Phase 10 — Editorial / dashboard voice cohesion

**Addresses findings:** G-05.

**Revised scope note (post-review):** The original plan included a Phase 10 task to strip Newsreader serif from homepage dashboard panels (specifically `homepage-flow-overview.tsx`). Direct inspection shows that file renders `<h2 className="text-xl font-semibold tracking-tight">` (Geist) — no Newsreader or serif usage. The Mint/Burn headline `Net burn day with worsening pressure` (copy sourced from `src/lib/flow-signal-ui.ts:235`) is rendered via `<span className="text-3xl font-black leading-[0.94] tracking-tight md:text-4xl 2xl:text-5xl">` in `flow-brrr-overview.tsx:220` — heavy Geist, not serif. That visual impression was a mistake in the audit. **Finding H-12 is withdrawn.** The only remaining `font-serif` usage in `src/components/` is `ai-summary.tsx:27` on the stablecoin detail page's AI summary block, which is an intentional editorial treatment and is out of scope.

What remains in Phase 10 is the documentation-level carve-out — pinning in `docs/design-language.md` that dashboard panels use Geist while the Digest surfaces continue using Newsreader.

### Task 10.1: Document the editorial / dashboard typography carve-out

**File:** `docs/design-language.md`

Add to the "Visual Direction" section (or its nearest equivalent; search `rg -n "Newsreader" docs/design-language.md`) a one-paragraph pin:

> **Typography carve-out.** Newsreader serif is reserved for the Daily Digest editorial surfaces: the `/digest/**` route and the homepage `DailyDigest` preview card. The detail-page `AiSummary` component uses Georgia serif for its AI-authored narrative paragraph — this is a second intentional carve-out. Every other dashboard panel on Pharos — including the homepage Market Snapshot, Core Monitoring band, Research Surfaces band, and all stablecoin-detail cards — uses Geist Sans at all weights. Do not introduce new serif usage outside these two carve-outs.

- [ ] **Step 1:** Add the paragraph; verify neighboring sections remain accurate.
- [ ] **Step 2:** Commit: `docs(design-language): pin editorial / dashboard typography carve-out`.

### Task 10.2: Regression guard against Newsreader bleed

**File:** `src/lib/__tests__/design-invariants.test.ts` (new, small test)

A minimal regression test so that a future commit adding `font-serif` or `Newsreader` to a dashboard panel fails at CI:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_SERIF_FILES = new Set<string>([
  "src/components/ai-summary.tsx",
  // Digest editorial surfaces:
  // (add concrete relative paths as the digest UI evolves)
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("design invariants", () => {
  test("font-serif is confined to allowed files", () => {
    const root = join(process.cwd(), "src/components");
    const offenders = walk(root).filter((file) => {
      const rel = file.replace(process.cwd() + "/", "");
      if (ALLOWED_SERIF_FILES.has(rel)) return false;
      if (rel.includes("/digest-") || rel.includes("/digest/")) return false;
      const src = readFileSync(file, "utf8");
      return /font-serif|Newsreader/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 1:** Confirm the current set of allowed files (`ai-summary.tsx` at minimum; add any digest-related components that legitimately use the serif treatment).
- [ ] **Step 2:** Write the test, run it, iterate until the test passes without any source edits.
- [ ] **Step 3:** Commit: `test(design): guard against Newsreader/serif bleed into dashboard panels`.

---

## Phase 11 — Accessibility & responsive verification

**Addresses findings:** G-08, G-10, and all earlier phases.

### Task 11.1: Full keyboard-navigation sweep

- [ ] Walk the homepage and a detail page (`/stablecoin/usdt-tether/`) end-to-end using Tab / Shift+Tab. Confirm: visible focus ring on every interactive element; skip-link works; command palette opens with Ctrl+K; scrollspy pills receive focus.
- [ ] Playwright test: press Tab 20 times on `/`; for each focused element assert `window.getComputedStyle(el).outlineStyle !== "none" || el.classList.contains("pharos-focus-ring")`.
- [ ] Commit any gaps found: `fix(a11y): restore focus ring on <component>`.

### Task 11.2: Contrast audit on the changed surfaces

No repository-level `check:a11y-contrast` npm script exists (verified against `package.json`). Use an external tool for this task:

- Load each target URL in Chrome with the DevTools "Inspect → Accessibility" panel, OR use the `axe-core` browser extension, OR run `npx pa11y <url>` against a locally served static export.

Surfaces to verify in **both** themes at 1440px and 390px:
- Masthead tagline text vs background (target ≥4.5:1)
- Market Snapshot secondary cell numbers and kickers
- Hero signals rail pills in the detail hero (new in Task 5.1)
- Zone band kickers against the darker band background (changed in Task 4.1)
- The Start Here callout heading and CTA contrast

- [ ] **Step 1:** Run axe-core or pa11y against the homepage and the USDT detail page in dark and light mode; capture the report as a file under `agents/plans/_ux-remediation-a11y/`.
- [ ] **Step 2:** Fix any failures via `text-*-700 dark:text-*-400` pairing (per `docs/design-language.md` → "Light-Mode Contrast Baseline").
- [ ] **Step 3:** Commit: `fix(a11y): resolve contrast failures flagged by axe on remediated surfaces`.

### Task 11.3: Run the full merge gate

- [ ] `npm run test:merge-gate`
- [ ] Fix any failing check on the same branch.
- [ ] Commit: `chore(merge-gate): pass full gate post-remediation`.

---

## Phase 12 — Documentation

### Task 12.1: Update `docs/design-language.md`

- [ ] Update the Masthead section with the new tagline breakpoint rule (Phase 2.2).
- [ ] Update the KPI Snapshot section with the new secondary weight rule (Phase 2.3) and the new PSI delta rule (Phase 3.2).
- [ ] Update the editorial / dashboard typography carve-out (already added in Phase 10.1 — cross-link here).
- [ ] Add a "Breadcrumb" section describing the shared component and its use (Phase 8.1).
- [ ] Add a "Hero signals rail" section for the detail page (Phase 5.1).
- [ ] Commit: `docs(design-language): reflect UX remediation`.

### Task 12.2: Update `docs/homepage.md`

- [ ] Update the top-fold section order note for `<lg` first-session (Phase 2.5).
- [ ] Update the Research Surfaces section to describe the new 2-col grid at `lg+` (Phase 4.5).
- [ ] Note the new "Last refreshed" line under the Market Snapshot (Phase 3.4).
- [ ] Commit: `docs(homepage): reflect remediation`.

### Task 12.3: Update stablecoin-detail and report-card docs

- [ ] **`docs/stablecoin-detail-page.md`** — confirm the file exists at that path (the repo has `docs/stablecoin-detail-page.md` per the audit agent's survey); if the path differs, use the real one. Update:
  - New scrollspy pill set (Phase 6.1) and the new `#overview` / `#price` split (Phase 6.2).
  - New hero signals rail (Phase 5.1).
  - New `FREEZABLE` chip label replacing `BLACKLISTABLE` on the detail hero (Phase 1.6).
  - New classification taxonomy pills (Phase 5.6).
- [ ] **`docs/report-cards.md`** — update the radar chart label description if the mobile shortenings are user-visible (Phase 9.3). If this doc describes dimension names only and not mobile rendering, no update is needed.
- [ ] Commit: `docs(detail): reflect hero, scrollspy, and chip label changes`.

### Task 12.4: Update the changelog

**File:** `data/changelog/<next-entry>.json` (or the shape the existing `data/changelog/` directory uses — confirm before editing).

- [ ] Add an entry summarizing the UX remediation with a link back to this plan.
- [ ] Commit: `docs(changelog): add UX remediation entry`.

---

## Acceptance Criteria

A phase is done when:
1. All tasks in the phase have a matching commit on the working branch.
2. All listed verification steps have run and passed, with outputs pasted into each task checkbox note.
3. `npm run test:merge-gate` passes.
4. Visual diffs have been captured for the homepage and detail page at 390, 820, 1440 (dark) and 1440 (light).

The plan is complete when all 12 phases are shipped and the docs reflect the new behavior.

---

## Appendix A — Condensed Findings Index

Each finding has a code used elsewhere in this plan. Severity: P0 (block), P1 (high), P2 (medium), P3 (polish).

### Homepage (H)
- **H-01 (P1)** — Masthead tagline utilitarian; missing distinctiveness. *(Phase 2.1)*
- **H-02 (P1)** — Tagline hidden at 768–1023 px. *(Phase 2.2)*
- **H-03 (P1)** — Cryptic market-snapshot units: `bps`, `vs 7d avg`, `Turnover`. *(Phases 1.1, 3.1)*
- **H-04 (P2)** — 4 secondary KPIs feel equal-weight next to dominant PSI. *(Phase 2.3)*
- **H-05 (P2)** — First-session callout body is verbose. *(Phase 2.4)*
- **H-06 (P2)** — Zone-band differentiation subtle in dark mode. *(Phase 4.1)*
- **H-07 (P2)** — `7D` abbreviation on Depegs/Supply kicker. *(Phase 1.2)*
- **H-08 (P2)** — Peg browse strip and table visually run together. *(Phase 4.2)*
- **H-09 (P2)** — Daily Digest preview lacks orientation for first-time visitors. *(Phase 4.3)*
- **H-10 (P3)** — Upcoming Stablecoins header is marketing-flavored. *(Phase 4.4)*
- **H-11 (P2)** — Heavy `divide-x` on snapshot row. *(Phase 2.3)*
- **H-12 (withdrawn)** — Alleged Newsreader bleed into dashboard panels turned out to be a misread of the `flow-brrr-overview.tsx` heavy-weight Geist headline. No edit needed; the typography carve-out is documented via Phase 10.1 and regression-tested via Phase 10.2.
- **H-13 (P2)** — Research Surfaces repetitive (4 full-width charts). *(Phase 4.5)*
- **H-15 (P1)** — Mobile table has only 3 visible columns; no scroll affordance. *(Phase 9.1)*
- **H-16 (P3)** — Mobile header duplicates masthead wordmark. *(Phase 9.2)*
- **H-17 (P2)** — Mobile PSI card shows deltas hidden on desktop — inconsistent. *(Phase 3.2)*

### Stablecoin detail (D)
- **D-01 (P0)** — Safety grade surfaced 3× above the fold. *(Phase 5.1)*
- **D-02 (P1)** — Hero signal chip row is unordered by severity. *(Phase 5.2)*
- **D-03 (P1)** — `Bluechip: D ↗` cryptic for new users. *(Phase 1.4)*
- **D-04 (P2)** — Classification line buried in muted text. *(Phase 5.6)*
- **D-05 (P1)** — Scrollspy nav misses Flows/Reserves/Explore sections. *(Phase 6.1)*
- **D-06 (P1)** — "Overview" pill too broad. *(Phase 6.2)*
- **D-07 (P2)** — `Compare vs USDC` hard-coded peer. *(Phase 5.5)*
- **D-08 (P2)** — Explore Next columns visually unbalanced. *(Phase 7.1)*
- **D-09 (P2)** — "Review brief" vs "Open live compare" unclear. *(Phase 7.2)*
- **D-10 (P2)** — DEX Liquidity card density is heavy. *(deferred — not addressed in this plan; a density pass needs product input)*
- **D-11 (P2)** — Top pools table shows misleading `Price` column for stablecoin-only pools. *(deferred — needs schema confirmation)*
- **D-12 (P1)** — Mint/Burn empty state repeats 30D/90D tiles. *(Phase 5.4)*
- **D-13 (P1)** — Mobile chip row uneven heights. *(Phase 5.3)*
- **D-14 (P2)** — Stale-data banner verbose. *(Phase 9.5)*

### Global shell (G)
- **G-01 (P0)** — No shared `<Breadcrumb />` component. *(Phase 8.1, 8.2)*
- **G-02 (P1)** — Command palette has only one action. *(Phase 8.3)*
- **G-03 (P2)** — Telegram in primary sidebar is out of place. *(Phase 8.5)*
- **G-04 (P1)** — Sidebar groups default collapsed; TRACK is highest-traffic. *(Phase 8.4)*
- **G-05 (P2)** — Editorial voice not clearly carved out. *(Phase 10.1, 10.2)*
- **G-08 (P1)** — Mobile horizontal-scroll affordance missing. *(Phase 9.1)*
- **G-09 (P3)** — Radar chart mobile labels abbreviate awkwardly. *(Phase 9.3)*
- **G-10** — Focus states exist. Preserve. *(Phase 11.1)*
- **G-11 (P1)** — `PEG STATUS 137/147` ratio not explained. *(Phase 1.3)*
- **G-12 (P2)** — `Tracked 24H DEX Vol` supporting copy cryptic. *(Phases 1.1, 3.1)*
- **G-13 (P2)** — `Net Mint/Burn Flow` direction not obvious. *(Phase 3.1)*

**Findings deferred (not in this plan):** D-10 (liquidity-card density), D-11 (pool-table price column). Both need product confirmation before editing.

---

## Self-Review Checklist (author-run before execution handoff)

**Spec coverage**
- Every P0 finding maps to a task. ✓
- Every P1 finding maps to a task OR is explicitly deferred with reason. ✓
- Every P2/P3 finding either has a task or is acknowledged as deferred. ✓

**Placeholder scan**
- No `TODO`, `TBD`, `fill in`, `similar to Task N` patterns. ✓
- Every copy change in Phase 1/3/4 lists the verbatim old and new string. ✓
- Every new component is named with its file path. ✓

**Type / contract consistency**
- `<Breadcrumb items={...} />` — same prop name used in Phase 8.1 and 8.2. ✓
- Scrollspy section ids referenced in Phase 5.1 (`#safety`, `#liquidity`) match Phase 6.1 additions. ✓
- `DEFAULT_EXPANDED` shape matches the existing sidebar grouping (three keys). ✓
- `getPrimaryStaticComparisonPageForCoin` is the real helper used in `hero-card.tsx`. ✓
- No invented methodology endpoint or token name. ✓

**Dependency ordering**
- Phase 1 (copy) ships before Phase 3 (tooltips built on the copy). ✓
- Phase 5.1 (hero signals rail) references `#report-card` and `#liquidity` — both are existing anchor ids in `src/app/stablecoin/[id]/client.tsx` (lines 258, 314). Phase 6.1 adds the two new ids it depends on (`#reserves`, `#explore-next`) before adding them to the pill list. ✓
- Phase 8.1 (Breadcrumb component) ships before Phase 8.2 (migration). ✓
- Phase 8.3 (command-palette actions) imports `clearAll` (not `reset`) from `use-homepage-filters` — confirmed against `src/hooks/use-homepage-filters.ts:97, 116`. ✓
- Phase 12 (docs) runs last. ✓

**Risk & reversibility**
- No destructive DB or URL-contract changes.
- All changes are commit-sized and individually revertable.

---

## Execution Handoff

Plan complete and saved to `agents/plans/2026-04-17-ux-ui-remediation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task (or per phase), review between tasks, fast iteration. Use `superpowers:subagent-driven-development`.
2. **Inline Execution** — Execute tasks in the same session with checkpoints for review. Use `superpowers:executing-plans`.

Recommended phase ship order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12.
