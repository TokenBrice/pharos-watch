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
2. On the first occurrence, create the issue with the run/attempt URL and a bounded first actionable error excerpt. If logs expired or are unavailable, say so explicitly and link the run; do not invent an error. Existing exact-title issue-upsert workflows were the precedent; there was no generic issue helper to reuse.
3. Repeats comment on the same issue with the new run URL and excerpt, and update its body to the latest failure. Changed steps/matrix leaves get their own issues. Previous incidents stay open until the whole workflow recovers, even if one leaf has already recovered.
4. The next fully green mandatory run on main comments with its recovery URL and closes **all** incident issues in that workflow namespace. Only explicitly unselected jobs may be skipped: Safety Map's already-published render, or deploy surfaces classified unnecessary by a successful plan. Cancelled jobs, unexpected dependency skips, and all-skipped runs cannot close issues. Nightly's Node 26 advisory job is not mandatory.
5. A later recurrence reopens the original issue rather than creating a second issue for the same marker. Reporting jobs serialize per workflow; recorded run-number/attempt markers also prevent an older report from overwriting newer recorded state.

Do not edit/remove the HTML markers. Manual issue closure is not a substitute for a green workflow run: a continuing failure reopens it. Issue titles are human-readable, but deduplication uses body markers, not GitHub search indexing.

The old weekly dependency-coverage incident publisher is replaced by this lifecycle. Any historical “Dependency coverage weekly failure” issue is legacy operator-owned history: close it manually after reviewing its outstanding findings; the new reporter does not adopt an unmarked issue. Curation's “Safety Score curation expiry sweep” issue remains an independent review worklist and is **not** auto-closed by CI recovery. Its sweep job retains an explicitly commented job-level `issues: write` exception; all new incident mutations belong to the reporting jobs. No workflow-wide issue-write grant is added.

## First-failure ops alert and provisioning prerequisite

Reuse the existing **private** Worker ops Telegram destination: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OPERATOR_CHAT_ID`. There is deliberately no fallback to public digest `TELEGRAM_CHAT_ID`. See [Telegram bot-wide outage](./telegram-bot-wide-outage.md) for the existing operator-channel boundary.

The reporter sends one plain-text ops message when the workflow changes from no open incident to red. A newly failing step while another incident remains open does not send another message. Repeated failures only update/comment on issues. A fully green run closes the incidents; the next failure may alert again. A workflow with no incident history alerts on its first observed failure.

**Rollout is blocked for Telegram delivery until the existing credential names are provisioned as GitHub Actions secrets.** A GET-only repository secret-name inventory on 2026-10-08 listed neither `TELEGRAM_BOT_TOKEN` nor `TELEGRAM_OPERATOR_CHAT_ID`. Worker bindings do not automatically become Actions secrets, and this observation does not establish environment/organization secret inventories. Before enabling delivery, the maintainer must securely provision the bot token and private operator chat ID under those existing names for the reporting jobs. Never copy values into tracked files or use the public digest channel.

Issues are recorded before attempting delivery. Missing credentials or rejected Telegram delivery fail the reporting job with a visible prerequisite/transport error; they are not reported as a successful alert. Subsequent red runs do **not** resend an alert (at-most-once attempt per transition). If delivery failed, provision/fix the channel and notify ops manually for the already-open incident; do not delete markers or force a fake green run to trigger another notification.

## Response and verification

Follow [CI failure triage](../testing.md#ci-pipeline) and the owning producer/deployment runbook. Start with the linked run, failing job/step, and excerpt. Retained logs may contain more precise evidence than the bounded issue excerpt. Fix the cause, then run the smallest targeted reproduction. For production failures, [deployment acceptance](../deployment-process.md#operational-acceptance) distinguishes activation proof from live operational health. This reporter never retries jobs, mutates production, rolls back, or resets cron leases.

Reporter permissions are job-scoped `contents: read`, `actions: read` (Jobs/log evidence), and `issues: write`. Checkout disables persisted credentials; third-party actions are SHA-pinned; expressions enter action inputs/environment rather than interpolated shell source.

Focused contract coverage:

```bash
npx vitest run scripts/__tests__/report-workflow-failure.test.ts
```

The mocked-client suite covers creation, repeat comments, recovery closure, recurrence reopening, workflow-level first-failure alert suppression, named/matrix/reusable leaves, advisory exclusion, main/event guards, cancellation/skips, stale recorded state, provider acceptance, pagination, and all eight workflow reporting dependencies. It does not deliver a real Telegram message or mutate GitHub issues. Production issue/alert/recovery behavior requires a maintainer-authorized Actions observation after secrets provisioning.
