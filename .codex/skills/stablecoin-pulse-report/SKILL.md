---
name: stablecoin-pulse-report
description: Produce the monthly "Stablecoin Pulse" 2-page PDF for a partner team (default Polaris) from Pharos API data plus X and web research, explaining why supply, chains, and pegs moved. Use at month end or when asked for a monthly stablecoin trends/pulse report; not for the daily digest or Telegram pulse.
user_invocable: true
---

# Stablecoin Pulse Report

A concise, actionable monthly read of the stablecoin market: page 1 is the pulse (KPIs, TL;DR, top movers with their causes, launches, depegs and incidents, market-wide signals, what to watch); page 2 is the evidence annex with linked sources. The value is the **why**: "PYUSD +25%" is noise; "PYUSD +25%, half of it from its Aave/Arc integration" is the product.

Read [editorial-rules.md](references/editorial-rules.md) before writing copy, [research-briefs.md](references/research-briefs.md) before dispatching research, and [layout.md](references/layout.md) before building.

## Inputs

- Window end: the fetch time (UTC), with a rolling 30-day window matching Pharos `circulatingPrevMonth`. The fetcher has no historical-end option; run it on the last days of the month or the 1st of the next, and use `data/market.json.window` for the actual dates.
- Month label (e.g. `October 2026`) and partner name for the footer (default `Polaris`).
- Work directory: `agents/<YYYY-MM-DD>-pulse-report/` (ignored scratch). Prior months live in sibling `agents/*-pulse-report/` directories; reuse the previous `content.json` as the structural starting point, never its facts.

Prerequisites: `PHAROS_API_KEY` in the process environment or root `.env.local` (environment wins; report the name only if missing); Playwright Chromium or Google Chrome; Poppler (`pdfinfo`, `pdftoppm`) optional. X research needs live X search (see research-briefs.md).

## Workflow

### 1. Pull data

```bash
node .codex/skills/stablecoin-pulse-report/scripts/fetch-pulse-data.mjs --out agents/<YYYY-MM-DD>-pulse-report
```

Read `data/brief.md` end to end, then the data traps in editorial-rules.md. Before any research, list the candidate stories: the top gainers and losers by USD, material percentage movers, chain shifts, flagged single mints or burns (`large-mints.json`), unit-versus-price splits (`unit-moves.json`), and depegs. Resolve identity collisions (same ticker, different issuer) now.

### 2. Research in one parallel batch

Split the candidate stories into the five clusters in research-briefs.md. When delegation is available, dispatch one web researcher and one X scout per cluster together in a single batch (ten agents), all reading `data/brief.md`. Preflight X search with a control query first; if unavailable, run web-only and state "X unavailable" in the handoff. Without delegation, perform the research and skeptical review sequentially and disclose that review was not independent. Save every result verbatim to `research/<Agent>.md` (or named sequential-pass notes).

### 3. Write `content.json`

The orchestrator writes the copy; do not delegate synthesis. Follow the schema and character budgets in layout.md and the evidence ladder in editorial-rules.md. Every number must trace to `data/` or a cited source; every causal claim must match its evidence strength.

### 4. Fact-check

Dispatch one independent read-only reviewer when available (prompt in research-briefs.md) over `content.json`, `data/`, and `research/`; otherwise use the disclosed sequential review. Apply every accepted fix yourself; re-verify disputed numbers against `data/` rather than choosing between agents.

### 5. Build and inspect

```bash
node .codex/skills/stablecoin-pulse-report/scripts/build-pulse-pdf.mjs --dir agents/<YYYY-MM-DD>-pulse-report
```

The build fails on overflow or a page count other than two. Open `out/page-1.png` and `out/page-2.png` and inspect them visually: no clipping, collisions, split `−$` amounts, or orphaned heading words. Fix fit by trimming copy, never by shrinking type below the documented minimum.

## Completion Report

Report the PDF path, the three to five headline findings, drivers that remain unexplained ("no source names…"), data caveats that shaped the copy, the fact-check verdict and fixes applied, X search spend if known, and which agents or models ran. Do not commit or publish the report unless asked; it lives in ignored scratch.
