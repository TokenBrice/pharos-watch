# Mechanism measurements — write-once evidence archive

This directory is an **evidence archive**, not a data source that gets refactored.
Every file is a point-in-time measurement taken against a pinned block, and its
repo path is quoted elsewhere as the citation for a published claim. Moving,
renaming, reformatting, or "tidying" a file here silently breaks that citation.

## Layout

```
mechanism-measurements/<assetId>/<YYYY-MM-DD>-block-<number>[-shock-coverage].json     # CDP shock producers
mechanism-measurements/<assetId>/<snapshotObservedAt>-<snapshotId12>-protocol-api.json  # protocol-API producer
mechanism-measurements/<assetId>/<YYYY-MM-DD>-<label>.json                              # hand-taken captures
```

- The directory name must equal the journal's `assetId`; the shock-coverage
  registry generator fails closed if they diverge.
- Files ending in `-shock-coverage.json` are **shock-coverage journals**. They are
  discovered by `scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts`,
  hashed, and projected into `../shock-coverage-measurements-v1.json` with a
  `journalSha256` pin. Editing a byte of one of these files changes its pin and
  requires regenerating the registry in the same commit.
- Files ending in `-protocol-api.json` are **protocol-API evidence**. Inside the
  producer's allowlisted asset directories they are discovered and byte-replayed
  by `scripts/maintenance/measure-protocol-api-mechanism-metrics.ts` — on
  `--replay-all` (which CI runs) and again on every live capture — so each must
  stay canonical, and the pinned legacy USDe artifact is additionally checked
  against an inlined sha256. Editing a byte of one fails the run.
- Files with neither suffix have **no programmatic reader**. They are still
  load-bearing: many are cited by repo path in the `notes` / evidence fields of
  the V9 overlay files in the parent directory. Treat "no importer" as "no
  compiler will catch you", not as "unused".

## Rules

1. **Write once.** Add new dated files; never rewrite an existing one. A
   re-measurement is a new file at a new block, not an edit.
2. **Never move or rename.** Paths are citations. If a path must change, every
   overlay note and attestation row quoting it changes in the same commit.
3. **Deleting is a retention decision, not cleanup.** Journals are pinned by
   `journalSha256` in the generated registry and listed in
   `../shock-coverage-replay-attestations-v1.json`. Any pruning has to go through
   the registry generator so the pins and attestations stay coherent, and has to
   preserve the historical replay window (the 2021/2022 Liquity stress dates are
   deliberate evidence, not stale files).
4. **The runtime reads only the latest measurement per asset.** That is a
   statement about the score path, not a licence to delete the rest; the older
   files are the auditability of the published number.
