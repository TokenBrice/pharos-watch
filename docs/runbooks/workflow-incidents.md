# Main and scheduled workflow incidents

## Scope and ownership

The final `report-failures` job in these workflows owns CI incidents:

- `.github/workflows/nightly-validation.yml`
- `.github/workflows/weekly-validation.yml`
- `.github/workflows/dependency-scenarios-refresh.yml`
- `.github/workflows/safety-map-refresh.yml`
- `.github/workflows/curation-expiry-sweep.yml`
- `.github/workflows/protocol-api-mechanism-refresh.yml`
- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/rebuild-pages.yml`

It runs with `always()` after the mandatory jobs, only on `refs/heads/main` for push, schedule, or manual dispatch. It never reports PRs or non-main dispatches. The shared action is `.github/actions/report-workflow-failure/action.yml`; the dependency-free Node 24 entrypoint is `scripts/ci/report-workflow-failure.ts`. Reporting installs Node but not the npm workspace, so an install failure in a producer can still become an issue.

## Issue lifecycle

1. A mandatory job's `needs` result of `failure` triggers read-only GitHub Jobs/log requests. Named, matrix, and reusable workflow leaf jobs are matched to that failing parent. Every failed step gets one issue with a stable `pharos-workflow-incident:v1` HTML marker containing the workflow filename, job display name, and step name. A runner failure without a failed step gets a job-level incident instead.
2. On the first occurrence, create the issue with the run/attempt URL and a bounded first actionable error excerpt. Unavailable or expired job logs produce JSON evidence `{ "status": "unavailable", "reason": "job-log-unavailable" }` and a link to the run, distinct from a successfully retrieved log with no actionable error line retained; do not invent an error. Existing exact-title issue-upsert workflows were the precedent; there was no generic issue helper to reuse.
3. Repeats comment on the same issue with the new run URL and excerpt, and update its body to the latest failure. Changed steps/matrix leaves get their own issues. Previous incidents stay open until the whole workflow recovers, even if one leaf has already recovered.
4. The next fully green mandatory run on main comments with its recovery URL and closes **all** incident issues in that workflow namespace. Only explicitly unselected jobs may be skipped: Safety Map's already-published render, or deploy surfaces classified unnecessary by a successful plan. Cancelled jobs, unexpected dependency skips, and all-skipped runs cannot close issues. Nightly's Node 26 advisory job is not mandatory.
5. A later recurrence reopens the original issue rather than creating a second issue for the same marker. Reporting jobs serialize per workflow; recorded run-number/attempt markers prevent an older report from overwriting newer recorded state. The reporter also reads the workflow's completed successful main runs through the Actions API: a newer green run suppresses older reports even when that green run had no incident to close. Only push, schedule, and manual-dispatch runs participate in this watermark; PR/non-main runs never do.

Do not edit/remove the HTML markers. Manual issue closure is not a substitute for a green workflow run: a continuing failure reopens it. Issue titles are human-readable, but deduplication uses body markers, not GitHub search indexing.

The old weekly dependency-coverage incident publisher is replaced by this lifecycle. Any historical “Dependency coverage weekly failure” issue is legacy operator-owned history: close it manually after reviewing its outstanding findings; the new reporter does not adopt an unmarked issue. Curation's “Safety Score curation expiry sweep” issue remains an independent review worklist and is **not** auto-closed by CI recovery. Its sweep job retains an explicitly commented job-level `issues: write` exception; all new incident mutations belong to the reporting jobs. No workflow-wide issue-write grant is added.

## Notification channel

GitHub Actions status, step summaries, and deduplicated incident issues are the workflow reporting channel. The reporter does not send Telegram notifications or require Telegram credentials.

## Response and verification

Follow [CI failure triage](../testing.md#ci-pipeline) and the owning producer/deployment runbook. Start with the linked run, failing job/step, and excerpt. Retained logs may contain more precise evidence than the bounded issue excerpt. Fix the cause, then run the smallest targeted reproduction. For production failures, [deployment acceptance](../deployment-process.md#operational-acceptance) distinguishes activation proof from live operational health. This reporter never retries jobs, mutates production, rolls back, or resets cron leases.

Reporter permissions are job-scoped `contents: read`, `actions: read` (Jobs/log evidence), and `issues: write`. Checkout disables persisted credentials; third-party actions are SHA-pinned; expressions enter action inputs/environment rather than interpolated shell source.

Focused contract coverage:

```bash
npx vitest run scripts/__tests__/report-workflow-failure.test.ts
```

The mocked-client suite covers creation, repeat comments, recovery closure, recurrence reopening, named/matrix/reusable leaves, advisory exclusion, main/event guards, cancellation/skips, stale recorded state, GitHub provider boundaries, pagination, and all eight workflow reporting dependencies. It does not mutate GitHub issues. Production issue/recovery behavior requires an Actions observation.
