# GitHub Workflows Agent Notes

Applies to GitHub Actions workflows and their shared workspace setup.

## Read First

- `docs/deployment-process.md#ci-deploy-sequence`
- Publishing/release changes also require `docs/deployment-process.md#core-rules` and the affected deployment stage.
- `docs/testing.md#ci-pipeline`

## Invariants

- Protected main and the aggregate `PR gate` own releases. Require successful independent `secrets` and `prepare` jobs; selected validation and coverage must succeed. Only docs-only inline success permits skipped validation, and only explicit unselected coverage permits skipped coverage shards/merge.
- Both required Gitleaks scans must execute the snapshotted base scanner/helpers/policy, including `--tree` after merge checkout. A changed candidate scanner/policy is an additional check, never a replacement for trusted scanning.
- `prepare` owns install/bootstrap/history, one test-selection plan, inline docs-only checks, and workspace publication. Validation and coverage shards depend directly on preparation; the coverage merge must not wait for unrelated validation. Keep selected mixed-PR docs required and doc-sync single-owned.
- In `.github/workflows/deploy-cloudflare.yml`, package/check and apply D1 migrations before Worker deployment; allow secret-free Pages preparation in parallel, but gate live refresh, build, and Pages publication on any required Worker deployment.
- Grant least privilege, pin third-party actions by commit, and reference secret names only—never values; `.github/workflows/zizmor.yml` and `.github/workflows/codeql.yml` are the security backstops.

## Entrypoints & Generation

- `.github/workflows/pull-request-checks.yml` owns PR lanes; `.github/workflows/deploy-cloudflare.yml` owns post-merge ordering.
- `.github/workflows/pages-prepare.yml` owns the secret-free compile-input workspace; `.github/workflows/pages-release.yml` owns its Worker-gated refresh/build/publish. `.github/actions/setup-workspace/action.yml` owns shared setup, pinned ripgrep, and generated bootstrap inputs.

## Tests

- Workflow classifiers and CI contracts are covered under `scripts/__tests__/`; workflow/action security analysis is owned by `.github/workflows/zizmor.yml`.

## Common Checks

- `npm run check:pr -- --base=<ref>`; `npm run check:pages-release`; `npm run check:worker-config`.
