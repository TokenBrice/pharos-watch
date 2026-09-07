---
name: annotations-refresh
description: Drain the chart-annotation candidate queue into reviewed per-coin annotations. Use weekly during active event periods, monthly otherwise, or when queue-health checks warn.
user_invocable: true
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose.

# Annotation Refresh

`npm run candidates:annotations` writes machine-found events to ignored `agents/annotation-candidates.{md,json}`. Editorially classify each row as promote, drop, or defer; never auto-publish a producer signal.

## Recover The Backlog

Scheduled runs retain full immutable `agent-maintenance-candidates-<run-id>-<attempt>` artifacts for 90 days, covering monthly review plus a missed monthly review. The issue contains excerpts and a download link, not the complete backlog. Before a sweep, download all retained runs since the last handoff (include failed runs with partial artifacts). From the repository root, with GitHub read access:

```bash
set -o pipefail
history_dir=agents/annotation-history
mkdir -p "$history_dir"
since_date=$(node -e 'process.stdout.write(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))')
gh api --paginate -X GET 'repos/{owner}/{repo}/actions/workflows/agent-maintenance-candidates.yml/runs' \
  -f created=">=$since_date" -f status=completed -f per_page=100 --jq '.workflow_runs[].id' |
  while read -r run_id; do
    gh run download "$run_id" --pattern 'agent-maintenance-candidates-*' --dir "$history_dir/$run_id" || exit 1
  done
npm run candidates:annotations -- --replay "$history_dir"
```

Use a shell with `pipefail` enabled so a failed run listing does not look like an empty history. Download failures, expired runs, or runs without artifacts are coverage gaps to resolve/report; do not silently skip them. Existing local download directories can be reused for replay without redownloading. `--replay` is offline: it merges every `annotation-candidates.json` under that directory with the local queue, preserving legacy rows and deferrals. It never writes decisions or product annotations. Keep `agents/annotation-review.json`, the queue, and needed snapshots together in the review handoff; do not delete them merely because the scheduled issue changed.

On the first migration of a legacy Markdown queue, the producer preserves its exact original bytes as `agents/annotation-candidates.legacy.md` and links it from the new queue. Read that backup for indented deferral evidence, source gaps, and free-form review notes the row parser cannot interpret. Keep it in the handoff too; it is never overwritten automatically.

Live collection overlaps 14 days of tape history and follows cursors serially with page/deadline bounds. JSON `coverage` and queue source notes distinguish complete from incomplete collection windows. Missing pages/sources remain pending evidence even when the command succeeds. Review dispositions identify individual events; a complete collection window is not a completed editorial review. The legacy date-only `last_swept_at` comment is preserved for compatibility and no longer suppresses arrivals or advances automatically.

## Review

1. Read the recovered queue oldest-first, its source coverage and existing `annotation-review.json`, `shared/types/chart-annotation.ts`, `shared/data/annotations/curated-annotations.ts`, and each referenced `shared/data/annotations/coins/<id>.json`. Source files own shape, enum, severity, and validation. Match distinct same-day events by their printed `id`, not just date/coin/kind.
2. Promote only a discrete event supported by a primary source (issuer post-mortem, regulator filing, methodology changelog, transaction/on-chain proof) and not already represented within the same incident window. Secondary reporting may corroborate, not replace missing primary evidence.
3. Drop duplicates, low-signal/promotional items, unsupported chatter, and announcements without a live transition. Defer real events whose decisive source is not yet available; include the reason.
4. A producer `launch` hint is not an annotation enum. Use the established governance precedent only after runtime chart coverage exists.

## Apply

For promoted rows, add `{ date, kind, label, severity?, href?, note? }` to the per-coin JSON in ascending date order. Keep labels within the source limit and put rationale in `note`. Create/register a new coin file only when needed, following the loader’s existing pattern.

Record each decision by the exact printed row `id` in reviewer-owned `agents/annotation-review.json` (create it on the first review). The schema is exported as `AnnotationReviewSchema` by `scripts/maintenance/build-annotation-candidates.ts`:

```json
{
  "version": 1,
  "decisions": {
    "tape:example-event-id": {
      "disposition": "defer",
      "reviewedAt": "2026-09-07T12:00:00.000Z",
      "reason": "Await issuer post-mortem; revisit when published"
    }
  }
}
```

Use `promote`, `drop`, or `defer`; promoted rows must have their annotation edit applied before recording promotion. Keep promoted/dropped IDs to prevent replay from requeuing them, and retain a reason/trigger for deferrals. Preserve legacy row IDs on migration. Rerun the offline replay command after decisions: it removes promoted/dropped rows from the Markdown view, retains deferrals, and admits new same-day IDs. Do not advance `last_swept_at` or manufacture a reviewed interval from incomplete collection. Record promote/drop/defer counts in the closeout.

Validate:

```bash
npm run check:stablecoin-data
npm test -- curated-annotations
```

Report promoted counts by coin, drop reasons, each deferral trigger, remaining rows/oldest date, and checks. Never invent dates, collapse distinct multi-day events, or treat a producer signal as its own evidence.
