# Workflow failure triage

## Scope and ownership

Use this runbook for failed GitHub Actions validation, deployment, and scheduled automation runs. Workflow YAML defines required jobs, advisory jobs, and intentionally skipped surfaces; the owning producer or deployment runbook defines operational acceptance.

Nightly validation upserts and closes one `ci:nightly-red` issue and the weekly run replaces one `ci:weekly-report` report issue in place; no other workflow failure creates or reconciles GitHub incident issues. Domain-specific issue automation remains independent: scheduled-delivery incidents, curation review worklists, and agent-maintenance candidates retain their own owners and handling.

## Notification channel

Failures surface as red GitHub Actions runs and GitHub notifications. Job logs, step summaries, and retained artifacts provide the failure evidence; notification delivery follows the operator's GitHub notification settings.

## Scheduled start delay

GitHub starts this repository's `schedule` runs hours after their cron time, consistently. Measured over 2026-10-12 → 2026-11-09 (#1949): `weekly-validation` (Mon 06:17 UTC) started 6.5–9.5 h late, `agent-maintenance-candidates` (Mon 07:15) 7–9.5 h, `ops-followups` (Mon 07:30) 7–10 h, `ddr-curation-watch` (daily 09:27) 6–8 h and `curation-expiry-sweep` (Tue 05:45) 4.5–7 h. The cron minute is a not-before time, never a delivery time.

- Expect Monday reminders, the weekly CI report and DDR follow-ups in the afternoon or evening UTC. A scheduled run that has not started by its cron time plus 12 h is the incident threshold; an earlier absence is the normal delay.
- Acceptance of a workflow change cannot rely on the same-day scheduled run. Accept it from a manual `workflow_dispatch` on `main` at the merged SHA, then confirm the next scheduled run when it arrives.
- Do not move a cron earlier to compensate: reports and overdue reminders are computed at run time, so an earlier nominal time changes their window whenever GitHub does start on time.

## Response and verification

1. Capture the run URL/ID, attempt, event, head SHA, and whether that SHA is still current. Read the run and failed logs:

   ```bash
   gh run view <run-id> --repo TokenBrice/pharos-watch --json status,conclusion,event,headSha,workflowName,url,jobs
   gh run view <run-id> --repo TokenBrice/pharos-watch --log-failed
   ```

2. Collect **every failed leaf job and step**, its exact command, and the first actionable error. Expand matrix and reusable-workflow failures rather than stopping at their failed parent. If logs are unavailable or expired, record that limitation and preserve available summaries/artifacts; do not invent an error.
3. Interpret skipped jobs and steps through the workflow's classifier and dependencies. An unselected deploy surface may skip intentionally; the single Safety Map job intentionally skips browser setup and render/publish steps when planning finds today's map already published. Cancellation and unexpected dependency skips are not successful execution. Weekly's Node 26 compatibility job is advisory.
4. Follow [CI failure triage](../testing.md#ci-pipeline) and the owning producer/deployment runbook. Reproduce narrowly, fix all causal failed-leaf defects in one revision, and run the smallest targeted checks. Provider or infrastructure failures do not justify unrelated code changes.
5. Before an authorized replacement push, run focused authoring checks; `npm run check:pr` is optional broader feedback under [Pre-push readiness](../testing.md#pre-push-readiness). Hosted CI owns readiness; local receipts are optional diagnostics. For production failures, [deployment acceptance](../deployment-process.md#operational-acceptance) distinguishes activation proof from live operational health.

Do not infer runtime recovery from a green workflow alone. The [memory monitor](./cron-slot-abandonment.md#first-checks), for example, can establish no currently observed alerting heavy kill with fresh available required Analytics evidence, not capacity or a fixed runtime defect; public kills and public broad-sample incompleteness remain report-only initially. Follow the owning runbook's observation and authority requirements before retries, production mutations, rollback, or lease changes.
