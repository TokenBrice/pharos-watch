---
name: annotations-refresh
description: Review the annotation candidate queue and curate per-coin editorial history. Use weekly in active periods, monthly otherwise, or on queue warnings. Not for restoring the retired chart overlay.
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose, and [Punctuation and labels](../../../docs/editorial-style.md#punctuation-and-labels) governs annotation titles.

# Annotation Refresh

## Trigger And Exclusions

`npm run candidates:annotations` writes machine-found events to ignored `agents/annotation-candidates.{md,json}`. Classify each row as promote, drop, or defer; never auto-publish a producer signal. The chart overlay is retired and stays retired. Retention of artifacts, queues and review files follows [Recurring Maintenance](../../../docs/process/agent-artifacts.md#recurring-maintenance).

## Mandatory Core

The curated corpus has two live readers; weigh every promotion against them:

- **Depeg event pages** (`findCuratedAnnotation` in `src/app/depeg/[event]/page.tsx`): the best `kind: "depeg"` row within the match window of the event start becomes the public page title, breadcrumb and structured-data headline; `severity` breaks ties before proximity, and `href` renders the Primary source card. Date a depeg row to the event start and give it the primary-source `href`.
- **Daily digest cause context** (`collectCauseContext` in `worker/src/cron/daily-digest/cause-context.ts`): rows of any kind dated in the lookback before a top depeg are the only causal context the digest may cite, with `label`, `date` and `href` passed through.

Prioritize depegs, exploits, freeze or blacklist surges, and regulatory or other material incidents. A routine launch or milestone row reaches no reader unless the coin later depegs inside the lookback: drop it unless it is tied to a stress event. Both source files own their windows and caps.

For pinned RPC reads and provenance, follow [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence).

## Recover And Review

The issue holds excerpts, not the backlog. Before a sweep, download every retained run since the last handoff (include failed runs with partial artifacts), from the repository root with GitHub read access:

```bash
history_dir=agents/annotation-history
mkdir -p "$history_dir"
since_date=$(node -e 'process.stdout.write(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))')
run_ids=$(gh api --paginate -X GET 'repos/{owner}/{repo}/actions/workflows/agent-maintenance-candidates.yml/runs' \
  -f created=">=$since_date" -f status=completed -f per_page=100 --jq '.workflow_runs[].id') || exit 1
gaps=()
for run_id in $run_ids; do
  gh run download "$run_id" --pattern 'agent-maintenance-candidates-*' --dir "$history_dir/$run_id" || gaps+=("$run_id")
done
npm run candidates:annotations -- --replay "$history_dir"
if ((${#gaps[@]})); then echo "coverage gaps (expired or missing artifacts): ${gaps[*]}" >&2; fi
```

A failed run listing stops the sweep; it is not an empty history. Every listed gap is unreviewed coverage to report, never a silent skip. Reuse existing download directories. `--replay` is offline: it merges every retained `annotation-candidates.json` with the local queue, keeping legacy rows and deferrals, and writes no decisions. Pass `--review <path>` when the review file is not `agents/annotation-review.json`. If `agents/annotation-candidates.legacy.md` exists, read it for deferral evidence the row parser cannot interpret and keep it in the handoff.

JSON `coverage` and queue source notes separate complete from incomplete collection windows. Missing pages or sources stay pending evidence even when the command succeeds, and a complete window is not a completed review.

1. Read the queue oldest-first with its coverage and existing review file, `shared/types/chart-annotation.ts`, `shared/data/annotations/curated-annotations.ts`, and each referenced `shared/data/annotations/coins/<id>.json`. Source files own shape, enum, severity and validation. Match same-day events by printed `id`, not date/coin/kind.
2. Promote only a discrete event with a primary source (issuer post-mortem, regulator filing, methodology changelog, transaction or on-chain proof) not already represented in the same incident window. Secondary reporting corroborates; it never replaces missing primary evidence.
3. Drop duplicates, promotional or low-signal items, unsupported chatter, and announcements without a live transition. Defer real events whose decisive source is not yet available, with the reason and trigger.
4. A producer `launch` hint is not an annotation kind. Use an established curated kind only when the evidence supports it; never invent one.

## Apply And Validate

Add promoted rows as `{ date, kind, label, severity?, href?, note?, quoted? }` to the per-coin JSON in ascending date order. Keep labels within the source limit, put rationale in `note`, and set `quoted: true` on a verbatim external title. Create and register a new coin file only when needed, following the loader's pattern.

Record each decision under its exact printed row `id` in reviewer-owned `agents/annotation-review.json` (`AnnotationReviewSchema` in `scripts/maintenance/build-annotation-candidates.ts`): `{ "version": 1, "decisions": { "<id>": { "disposition": "promote" | "drop" | "defer", "reviewedAt": "<ISO timestamp>", "reason": "<why, and the trigger for a deferral>" } } }`. Apply the annotation edit before recording a promotion. Keep promoted and dropped IDs so replay does not requeue them, then rerun the replay command. Never advance `last_swept_at` or claim a reviewed interval from incomplete collection.

```bash
npm run check:stablecoin-data
npm test -- curated-annotations
```

## Completion Evidence

Report promoted counts by coin, drop reasons, each deferral trigger, coverage gaps, remaining rows with the oldest date, and checks run. Never invent dates, collapse distinct multi-day events, or treat a producer signal as its own evidence.
