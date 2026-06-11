---
name: ai-summaries-refresh
description: Drain the AI-summary staleness queue (from `npm run candidates:ai-summaries`) in data/ai-summaries.json. Use after a score methodology bump, a depeg batch, or on a ~monthly cadence.
user_invocable: true
---

# AI Summaries Refresh

Editorial sweep that keeps the editorial summaries on stablecoin detail pages
honest about the numbers shown right next to them. Summaries hard-code claims a
reader can verify against the hero card and report card — an overall safety
grade ("the A- at 82"), a DEWS band ("in the Calm band"), a peg score, a
dimension grade ("a D in dependency risk"), a depeg-event count. Those drift as
the live scoring updates, leaving the prose contradicting the dashboard.

The producer (`scripts/maintenance/build-ai-summary-staleness-candidates.ts`)
diffs every summary's baked-in claims against live `report-cards`,
`stress-signals`, and `peg-summary`, and writes the mismatches to
`agents/ai-summary-candidates.{md,json}`. This skill turns each candidate into a
corrected summary. The rewrite is always editorial — the producer never edits
summaries.

## When to run

- After a report-card / peg-score / DEWS methodology version bump (grades shift
  across the board).
- After a cluster of depeg events or a notable grade move on a tracked coin.
- Monthly otherwise, or whenever a `high`-severity contradiction is reported
  on a high-profile coin.

## Inputs

1. Run the producer first:

   ```bash
   PHAROS_API_KEY=… npm run candidates:ai-summaries
   ```

   Defaults to `https://api.pharos.watch`; override with `PHAROS_API_BASE`, or
   pass `--fixtures <dir>` to read pre-fetched `report-cards.json` /
   `stress-signals.json` / `peg-summary.json`.

2. `agents/ai-summary-candidates.json` — machine queue. Each candidate carries
   `id`, `name`, `symbol`, `maxSeverity`, and a `findings[]` list of
   `{ kind, claimed, current, severity }`.
3. `data/ai-summaries.json` — the summaries to edit (keyed by coin id).
4. `shared/data/stablecoins/coins/<id>.json` — per-coin metadata for grounding
   (collateral, pegMechanism, reserves, flags, notices, yieldConfig).
5. The `write-ai-summaries` skill — the canonical voice, structure, and
   anti-patterns. **This skill defers to it for tone and editorial bar.**

## Severity triage

- **high** — visible hero contradiction: the overall safety grade or the DEWS
  band changed. Always refresh.
- **medium** — a dimension grade changed, or a cited score is off by 5+ points,
  or a depeg count is materially wrong. Refresh.
- **low** — minor ±3-4 score drift or slow depeg-count growth. Refresh only
  during a full sweep; otherwise leave.

## Process — per candidate

1. Read the current summary, the `findings[]`, and the coin's metadata file.
2. Rewrite **correct + de-brittle**:
   - **Correct** every stale claim to the current value (use the `findings`
     `current` field — do not re-derive).
   - **De-brittle** the figure that caused the staleness. A summary went stale
     because it pinned a volatile number; do not just swap in a new volatile
     number that will re-break next cycle:
     - **Overall grade**: citing the current letter grade is fine (grades move
       slowly). Avoid re-pinning the exact numeric score unless it is the
       editorial point.
     - **DEWS band/score**: the most volatile signal (30-min cadence). Prefer to
       drop the hard-coded band, or frame it as a tendency ("rarely leaves the
       calm end of the stress scale"), not a snapshot.
     - **Depeg count**: a rolling 4-year window that grows and ages out. Frame
       relatively ("hundreds of sub-50-bps blips") instead of an exact count.
   - Preserve voice and every claim that is still true. Surgical edits — do not
     rewrite sound prose for its own sake. Keep the `title` unless it embeds a
     stale grade.
3. Do not invent facts. Ground new claims in the metadata file or the live
   `findings`. If the staleness exposes a story the old summary missed (a real
   downgrade, a new active depeg), say so plainly — that is editorial gold per
   `write-ai-summaries`.

## Provenance

A refresh is AI-drafted, owner-reviewed. On each edited entry set:

```json
"model": "claude-opus-4-8",
"authoredBy": "ai",
"updatedAt": "<today>",
"factsAsOf": "<today>",
"reviewedBy": "@TokenBrice",
"reviewedAt": "<today>"
```

`reviewedAt`/`reviewedBy` are set only when the owner signs off on the batch —
the refresh is presented for review before those land. Never stamp a review
that has not happened.

## Verify

After writing the batch, re-run the producer and confirm the refreshed coins no
longer surface as `high`/`medium` (a relativized claim drops out because it no
longer carries a checkable number; a corrected grade matches live):

```bash
PHAROS_API_KEY=… npm run candidates:ai-summaries
```

Then run `npm run typecheck` (the JSON import is typed) before committing.
