# GitHub Workflows Agent Notes

Applies to GitHub Actions workflows and their shared workspace setup.

## Read First

- `docs/deployment-process.md`
- `docs/testing.md#ci-pipeline`

## Invariants

- Protected main and the aggregate PR gate own releases; keep the `docs_changed` lane required when documentation is selected.
- In `.github/workflows/deploy-cloudflare.yml`, package/check and apply D1 migrations before Worker deployment; gate Pages on any required Worker deployment.
- Grant least privilege, pin third-party actions by commit, and reference secret names only—never values; `.github/workflows/zizmor.yml` and `.github/workflows/codeql.yml` are the security backstops.

## Entrypoints & Generation

- `.github/workflows/pull-request-checks.yml` owns PR lanes; `.github/workflows/deploy-cloudflare.yml` owns post-merge ordering.
- `.github/workflows/pages-release.yml` owns the Pages artifact; `.github/actions/setup-workspace/action.yml` owns shared setup and generated bootstrap inputs.

## Tests

- Workflow classifiers and CI contracts are covered under `scripts/__tests__/`; workflow/action security analysis is owned by `.github/workflows/zizmor.yml`.

## Common Checks

- `npm run check:pr -- --base=<ref>`; `npm run check:pages-release`; `npm run check:worker-config`.
