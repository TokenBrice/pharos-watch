---
name: annotations-refresh
description: Drain the chart-annotation candidate queue into reviewed per-coin annotations. Use weekly during active event periods, monthly otherwise, or when queue-health checks warn.
user_invocable: true
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose.

# Annotation Refresh

`npm run candidates:annotations` writes machine-found events to ignored `agents/annotation-candidates.md`. Editorially classify each row as promote, drop, or defer; never auto-publish a producer signal.

## Review

1. Read the queue oldest-first, its `last_swept_at`, `shared/types/chart-annotation.ts`, `shared/data/annotations/curated-annotations.ts`, and each referenced `shared/data/annotations/coins/<id>.json`. Source files own shape, enum, severity, and validation.
2. Promote only a discrete event supported by a primary source (issuer post-mortem, regulator filing, methodology changelog, transaction/on-chain proof) and not already represented within the same incident window. Secondary reporting may corroborate, not replace missing primary evidence.
3. Drop duplicates, low-signal/promotional items, unsupported chatter, and announcements without a live transition. Defer real events whose decisive source is not yet available; include the reason.
4. A producer `launch` hint is not an annotation enum. Use the established governance precedent only after runtime chart coverage exists.

## Apply

For promoted rows, add `{ date, kind, label, severity?, href?, note? }` to the per-coin JSON in ascending date order. Keep labels within the source limit and put rationale in `note`. Create/register a new coin file only when needed, following the loader’s existing pattern.

Rewrite the queue after all decisions: remove promoted/dropped rows, retain marked deferrals, update `last_swept_at` to today, and record promote/drop/defer counts. Do not change the producer’s queue layout.

Validate:

```bash
npm run check:stablecoin-data
npm test -- curated-annotations
```

Report promoted counts by coin, drop reasons, each deferral trigger, remaining rows/oldest date, and checks. Never invent dates, collapse distinct multi-day events, or treat a producer signal as its own evidence.
