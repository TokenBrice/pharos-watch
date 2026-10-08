# Mechanism measurements — write-once evidence archive

This directory is an **evidence archive**, not a data source that gets refactored.
Every file is a point-in-time measurement taken against a pinned block or source observation clock, and its
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
- Files ending in `-protocol-api.json` are **permanent non-publishing protocol-API evidence**. Reviewed weekly/manual automation remains supported; direct score adoption is blocked. Target-directory V2 bodies must be canonical and raw-byte replayable. The single frozen USDe V1 path verifies original normalized bytes and its exact SHA-256, never raw-source replay. Summary metadata alone is not byte verification. Strict `--replay`/`--replay-all` separate verified V2, hash-verified normalized-only V1 and unavailable outcomes; unavailable evidence exits nonzero.
- Original bytes resolve locally, then from a hash-checked `agents/.cache/measurements/` cache, otherwise by signed R2 GET (`pinned/`, then `captures/`) with hash verification and a local cache write. Network-free replay requires local original bytes/cache; missing access, expired objects and corrupt bodies are not preservation success.
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
4. **Score authority is producer-specific.** Shock registries project admitted latest measurements; protocol-API journals remain evidence for human review and are never automatically imported into scores. Older original bytes, summaries, pins and citations remain the audit trail.

## Local wrapper evidence

The fxSAVE wrapper capture deliberately remains `complete:false`, with CDP metrics N/A and local backing accounting analogous-only. Its July 15 local capture pins Ethereum block 25,536,894; the reviewed July 20 dossier combines separate local accounting at block 25,572,053 with the dated July 15 parent fxUSD evidence. Parent attachment is already present in the reviewed overlay, not in the standalone local journal. Keep both original hashes, paths and clocks distinct; metadata linkage cannot grant new reserve, liquidation or recovery credit.
