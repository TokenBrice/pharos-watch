# GitHub Workflows Agent Notes

Applies to GitHub Actions workflows and their shared workspace setup.

## Read First

- `docs/deployment-process.md#ci-deploy-sequence`
- Publishing/release changes also require `docs/deployment-process.md#core-rules` and the affected deployment stage.
- `docs/testing.md#ci-pipeline`

## Invariants

- Protected main and the aggregate `PR gate` own releases. Require successful independent `secrets` and `prepare` jobs; selected validation, coverage, and `pages-artifact` must succeed. Only docs-only inline success permits skipped validation, and only explicit unselected coverage/Pages permits those jobs to skip. The Pages lane is selected by the shared classifier's Pages/build-pipeline predicate, not every PR.
- Both required Gitleaks scans must execute the snapshotted base scanner/helpers/policy, including `--tree` after merge checkout. A changed candidate scanner/policy is an additional check, never a replacement for trusted scanning.
- `prepare` owns install/bootstrap/history, one test-selection plan, inline docs-only checks, and workspace publication. Validation and coverage shards depend directly on preparation; the coverage merge must not wait for unrelated validation. Keep selected mixed-PR docs required and doc-sync single-owned.
- Keep selection base/branch head distinct from the tested merge checkout. `scripts/lib/pr-lanes.mts` owns commands, lane timeouts and profiles; consume one frozen test plan and coverage refs instead of reselecting in shards.
- Install Firefox only when selected generated artifacts declare it through registry `requiredBrowsers`; do not use a blanket OG predicate. Keep browser setup out of the offline Pages artifact lane.
- In `.github/workflows/deploy-cloudflare.yml`, package/check and apply D1 migrations before Worker deployment; allow secret-free Pages preparation in parallel, but gate live refresh, build, and Pages publication on any required Worker deployment.
- PR Pages artifact jobs use production public flags, clean compiler state, no live refresh or production secrets, and read-only `actions: read` to replay successful trusted-main release data. Explicit degraded-data fallback retains every artifact gate and discloses weaker detail-size evidence; corrupt artifacts fail. Pages releases retain the allowlisted non-secret `pages-release-data-<sha>` snapshot for 14 days, separately from the one-day preparation workspace.
- Identity re-verification failures must not suppress remaining deployment acceptance probes: preserve the `always()` acceptance step and heavy identity checks in `deploy-cloudflare.yml`, per-probe evidence, and `failureKind`. Do not mislabel `activated; operational acceptance failed` as an activation failure.
- Grant least privilege, pin third-party actions by commit, and reference secret names only—never values; `.github/workflows/zizmor.yml` and `.github/workflows/codeql.yml` are the security backstops.
- Incident reporting uses `.github/actions/report-workflow-failure/action.yml` in a terminal `report-failures` job with mandatory `needs` and `always()`, restricted to `refs/heads/main` push/schedule/manual events—never PRs. Grant `contents: read`, `actions: read`, and `issues: write` at **job scope**, not workflow scope; serialize `workflow-incidents-${{ github.workflow }}` with `cancel-in-progress: false`.
- Pass `toJSON(needs)`, the stable workflow filename, job-ID/display-name mapping, and only classifier-proven `allowed-skips` to the reporter. Recovery closes incidents only after every mandatory job is green (or explicitly unselected); cancellation and unexplained skips are not recovery. Workflow/job/step issues deduplicate repeats; only the green-to-red transition sends the private operator Telegram alert, never a public digest message. See `scripts/ci/report-workflow-failure.ts` and `docs/runbooks/workflow-incidents.md`; missing Actions alert secrets remain an operational prerequisite.

## Entrypoints & Generation

- `.github/workflows/pull-request-checks.yml` owns PR lanes; `.github/workflows/deploy-cloudflare.yml` owns post-merge ordering.
- `.github/workflows/pages-prepare.yml` owns the secret-free compile-input workspace; `.github/workflows/pages-release.yml` owns its Worker-gated refresh/build/publish. `.github/actions/setup-workspace/action.yml` owns shared setup, pinned ripgrep, and generated bootstrap inputs.

## Tests

- Workflow classifiers and CI contracts are covered under `scripts/__tests__/`; workflow/action security analysis is owned by `.github/workflows/zizmor.yml`.

## Common Checks

- Full plain `npm run check:pr` on final committed state before every push; focused checks/`--plan` are feedback only. Add `npm run check:pr -- --ci-parity` for unreproduced remote failures or lockfile/setup/security-policy changes. Artifact/profile helpers: `npm run check:pages-artifact`, `npm run check:pages-release`, `npm run check:worker-config`.
