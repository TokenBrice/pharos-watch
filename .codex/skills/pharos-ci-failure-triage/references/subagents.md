# Pharos CI Failure Triage Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## GitHub Actions Log Investigator

Capability: spawn a read-only reviewer.

```text
Investigate Pharos GitHub Actions run <RUN_ID>. Do not edit files.

Read the run metadata and failed logs with gh, then docs/testing.md and docs/deployment-process.md.

Return: workflow/run URL/head SHA; every failed leaf job/step with its exact command and first actionable error; smallest local repro per leaf and required runtime/environment; failure classes; whether skipped jobs match classifier behavior; likely files and independent defects to batch in one causal revision. Stay evidence-backed, do not stop at the aggregate/first failure, and avoid broad fixes. Use ci:census for trend measurement only if explicitly requested, never as failure reproduction.
```

## CI Reproduction Mapper

Capability: spawn a read-only reviewer.

```text
Map the pasted Pharos CI failure to local reproduction and ownership. Do not edit files.

Read docs/testing.md#pre-push-readiness, docs/deployment-process.md, docs/scripts.md, package.json scripts, and only the relevant adaptive-check or artifact-registry source.

Return: every failed leaf's smallest repro; likely source/scripts; affected docs; common false leads; and mandatory post-fix readiness evidence. Narrow repro comes first, then all causal fixes, final-history full generated convergence, full plain npm run check:pr without skip/filter/plan-only/no-fetch flags or selection overrides, and a fresh passing .tmp/pr-check-receipts/<HEAD>.json before one authorized replacement push. Focused success is not readiness. Identify supplemental ci-parity for an unreproduced remote failure or lockfile/setup/security-policy changes, and with-coverage/with-pages for remote failures or floor/budget changes per Testing. Do not propose check:release unless production rehearsal was requested; ci:census is for requested trends only.
```
