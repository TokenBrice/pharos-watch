# Workflow failure triage

## Scope and ownership

Use this runbook for failed GitHub Actions validation, deployment, and scheduled automation runs. Workflow YAML defines required jobs, advisory jobs, and intentionally skipped surfaces; the owning producer or deployment runbook defines operational acceptance.

Workflow failures do not create or reconcile GitHub incident issues. Domain-specific issue automation remains independent: scheduled-delivery incidents, curation review worklists, and agent-maintenance candidates retain their own owners and handling.

## Notification channel

Failures surface as red GitHub Actions runs and GitHub notifications. Job logs, step summaries, and retained artifacts provide the failure evidence; notification delivery follows the operator's GitHub notification settings.

## Response and verification

1. Capture the run URL/ID, attempt, event, head SHA, and whether that SHA is still current. Read the run and failed logs:

   ```bash
   gh run view <run-id> --repo TokenBrice/pharos-watch --json status,conclusion,event,headSha,workflowName,url,jobs
   gh run view <run-id> --repo TokenBrice/pharos-watch --log-failed
   ```

2. Collect **every failed leaf job and step**, its exact command, and the first actionable error. Expand matrix and reusable-workflow failures rather than stopping at their failed parent. If logs are unavailable or expired, record that limitation and preserve available summaries/artifacts; do not invent an error.
3. Interpret skipped jobs through the workflow's classifier and dependencies. An unselected deploy surface or already-published Safety Map render may skip intentionally; cancellation and unexpected dependency skips are not successful execution. Weekly's Node 26 compatibility job is advisory.
4. Follow [CI failure triage](../testing.md#ci-pipeline) and the owning producer/deployment runbook. Reproduce narrowly, fix all causal failed-leaf defects in one revision, and run the smallest targeted checks. Provider or infrastructure failures do not justify unrelated code changes.
5. Before an authorized replacement push, use `npm run check:pr` for focused authoring feedback under [Pre-push readiness](../testing.md#pre-push-readiness); hosted CI is the readiness authority, and local receipts are optional diagnostics. For production failures, [deployment acceptance](../deployment-process.md#operational-acceptance) distinguishes activation proof from live operational health.

Do not infer runtime recovery from a green workflow alone. The [memory monitor](./cron-slot-abandonment.md#first-checks), for example, can establish no currently observed alerting heavy kill with fresh available required Analytics evidence, not capacity or a fixed runtime defect; public kills and public broad-sample incompleteness remain report-only initially. Follow the owning runbook's observation and authority requirements before retries, production mutations, rollback, or lease changes.
