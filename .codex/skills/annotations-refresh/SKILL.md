---
name: annotations-refresh
description: Drain the annotation-candidates queue (from `npm run candidates:annotations`) into the per-coin JSON assets under shared/data/annotations/coins/. Use weekly during active event periods, monthly otherwise.
user_invocable: true
---

# Annotations Refresh

Editorial sweep of chart-annotation candidates. The producer
(`scripts/maintenance/build-annotation-candidates.ts`) writes machine-found
events to `agents/annotation-candidates.md`. This skill reads that queue and
turns each row into a promote / drop / defer decision, updating the
per-coin JSON file under `shared/data/annotations/coins/` for promoted rows.

Promotion is always editorial. Do not auto-write annotations from the queue.

## When to run

- Weekly during high-event periods (post-depeg, post-regulatory action,
  post-launch burst).
- Monthly otherwise.
- Whenever `npm run digest:curation` flags `WARN:` on annotation queue
  health (queue > 30 rows or oldest candidate > 60 days old).

## Inputs

- `agents/annotation-candidates.md` — append-only queue. Each row already
  carries a date, coin id, kind hint, severity hint, and a source pointer.
  The file footer `<!-- last_swept_at: YYYY-MM-DD -->` records the previous
  sweep date.
- `shared/data/annotations/coins/<coin-id>.json` — current curated set,
  one file per coin. `shared/data/annotations/curated-annotations.ts` is
  the typed loader (validation rules + severity vocabulary in its header).
- `shared/types/chart-annotation.ts` — `CHART_ANNOTATION_KINDS` and the
  `ChartAnnotation` shape (ts, kind, label ≤80 chars, severity?, href?).

## Process

### Step 1 — Read the queue and the current annotations file

If the queue has no candidate rows at all (fresh or deferred), report "queue
empty" with the `last_swept_at` date and stop — no edits anywhere.

1. Read `agents/annotation-candidates.md` from top to bottom. Group rows by
   date header so the older candidates surface first.
2. Read `shared/data/annotations/coins/<coin-id>.json` for each coin
   referenced in the queue, note the existing annotations so duplicates
   can be detected.
3. Read `shared/types/chart-annotation.ts` to confirm the current
   `CHART_ANNOTATION_KINDS` enum — do not rely on this document's list,
   the source file wins.

### Step 2 — Per-row decision

For each candidate, choose one of three actions:

#### Promote

Add an entry to `shared/data/annotations/coins/<coin-id>.json` (create
the file and register its import in `curated-annotations.ts` if the coin
has no annotations yet). Required when:

- The event is a discrete, named occurrence (regulatory action, depeg
  pivot, launch, governance vote, methodology pivot, blacklist spike).
- A primary source exists (issuer post-mortem, regulator filing,
  methodology changelog, on-chain transaction). Secondary press is OK as
  fallback but prefer primary.
- The event is not already represented (check existing entries for the
  same coin within ±2 days of the candidate `ts`).

Entry shape (mirror existing file rules):

```ts
{
  ts: Date.UTC(YYYY, monthIdx, day), // months 0-indexed; comment with ISO date and short note
  kind: "depeg" | "regulatory" | "governance" | "mint-burn-spike" | "blacklist-surge" | "methodology-change" | "exploit", // mirror of CHART_ANNOTATION_KINDS — the source file wins
  label: string, // ≤80 chars, SR-only legend text
  severity?: "low" | "med" | "high",
  href?: string, // primary source URL
}
```

Place each new entry inside the per-coin array in `ts` ascending order.

Queue rows with kind hint `launch` have no matching enum kind — existing
launch annotations curate under `governance` (e.g. the USDe/USDS mainnet
launch entries); follow that precedent.

#### Drop

Add a `dropped: <one-line reason>` annotation next to the row in the
queue (a same-line suffix is safe — the producer only parses the leading
`date | coin | kind` fields). Do not delete the row in place — instead,
when finishing the sweep, strip dropped rows wholesale as part of the
queue rewrite (Step 4).

Common drop reasons:

- Below severity bar (depeg low ≥ $0.98 with no grade impact).
- Already curated under a different `ts` within the same incident.
- Press cycle without a discrete event (e.g. opinion piece, recap).
- Insufficient source — only social-media chatter.
- Promotional / launch announcement without a confirmed live transition.

#### Defer

Mark the row with `defer: <reason>` and leave it in the queue. Use when
the event is real but the source set is incomplete (e.g. a regulator
filing is rumored but not yet public). Re-evaluate next sweep.

### Step 3 — Apply the edits

1. Edit `shared/data/annotations/coins/<coin-id>.json` with the promoted
   rows. Entries use `{date: "YYYY-MM-DD", kind, label, severity?, href?,
   note?}`; put the editorial rationale in `note`.
2. Sort each coin's array by `date` ascending if the new entry breaks the
   order.
3. Keep the labels ≤80 chars. If a long label is required, prefer a
   shorter `label` and put the long phrasing in the source-page title at
   the `href` end.

### Step 4 — Update the queue

After all per-row decisions, rewrite `agents/annotation-candidates.md`:

1. Remove promoted rows (they are now in the curated file).
2. Remove dropped rows.
3. Keep deferred rows, with the `defer:` annotation visible.
4. Update the footer to today: `<!-- last_swept_at: YYYY-MM-DD -->`. The
   producer uses this date as an inclusive cutoff, preventing promoted and
   dropped events from reappearing on the next run.
5. Prepend a short header noting the sweep (e.g. `<!-- swept 2026-05-23:
   12 promoted, 8 dropped, 3 deferred -->`).

### Step 5 — Validate

Run the local gates before declaring done:

```bash
npm run check:stablecoin-data
npm test -- curated-annotations
```

The annotations test enforces: kind enum, ≤80 char labels, plausible
timestamps, and the top-4 coverage gate. If the test fails, fix the entry
(usually a label that crept over 80 chars or a `kind` typo) and re-run.

## Output

Report at the end of the sweep:

- Promoted count, grouped by coin (e.g. `usdc-circle: +1`,
  `usdt-tether: +2`).
- Dropped count with a one-line digest of common reasons.
- Deferred count and what each is waiting on.
- Queue health after sweep: rows remaining, oldest deferred row date.

## What NOT to do

- Do not invent dates. If the queue row's `ts` is fuzzy, defer rather
  than guess.
- Do not promote a row whose only source is the producer script's own
  signal (the producer surfaces the candidate, but a primary source —
  issuer post-mortem, regulator filing, methodology changelog, on-chain
  proof — must exist before the event becomes a curated annotation).
- Do not collapse multi-day depegs into a single entry; one annotation
  per discrete event, per the file header rules.
- Do not edit the producer script's queue layout. The producer rewrites
  the file each run; structural edits will be lost.
- Do not promote launch candidates appended by the orchestrator unless
  the coin already has live runtime coverage (the launch annotation is
  only meaningful once the chart actually renders data for that date).
