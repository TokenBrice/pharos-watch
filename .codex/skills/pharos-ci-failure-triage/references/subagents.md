# Pharos CI Failure Triage Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## GitHub Actions Log Investigator

Capability: spawn a read-only reviewer.

```text
Investigate Pharos GitHub Actions run <RUN_ID>. Do not edit files.

Read the run metadata and every failed leaf's logs with gh, then docs/testing.md#ci-pipeline and docs/deployment-process.md#ci-deploy-sequence. Use docs/testing.md#smallest-adequate-check-per-area for reproduction and docs/deployment-process.md#operational-acceptance only for activation/runtime failures; open other owner anchors as indicated by the failing command.

Return: workflow/run URL/head SHA; every failed leaf job/step with its exact command and first actionable error; smallest local repro per leaf and required runtime/environment; failure classes; whether skipped jobs match classifier behavior; likely files and independent defects to batch in one causal revision. Stay evidence-backed, do not stop at the aggregate/first failure, and avoid broad fixes. Use ci:census for trend measurement only if explicitly requested, never as failure reproduction.
```

## CI Reproduction Mapper

Capability: spawn a read-only reviewer.

```text
Map the pasted Pharos CI failure to local reproduction and ownership. Do not edit files.

Read docs/testing.md#pre-push-readiness, docs/testing.md#smallest-adequate-check-per-area, docs/scripts.md#validation-command-index, package.json scripts, and only the relevant adaptive-check or artifact-registry source. For deployment failures use docs/deployment-process.md#ci-deploy-sequence; for generated-artifact failures use docs/testing.md#generated-artifact-failure-playbook and docs/process/agent-artifacts.md#source-of-truth.

Return: every failed leaf's smallest repro; likely source/scripts; affected docs; common false leads; and post-fix evidence. Narrow repro comes first, then all causal fixes, generated-artifact updates and focused npm run check:pr feedback before one authorized replacement push. Local receipts are optional diagnostics; hosted CI is the readiness authority. Identify with-pages for Pages failures/budget changes and the direct weekly-equivalent coverage command for floor changes per Testing. Do not propose check:release unless production rehearsal was requested; ci:census is for requested trends only.
```
