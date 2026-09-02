# Pharos CI Failure Triage Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## GitHub Actions Log Investigator

Capability: spawn a read-only reviewer.

```text
Investigate Pharos GitHub Actions run <RUN_ID>. Do not edit files.

Read the run metadata and failed logs with gh, then docs/testing.md and docs/deployment-process.md.

Return: workflow/run URL/head SHA; failed job and step; first actionable error; smallest local repro and required runtime/environment; failure class; whether skipped jobs match classifier behavior; likely files. Stay evidence-backed and avoid broad fixes.
```

## CI Reproduction Mapper

Capability: spawn a read-only reviewer.

```text
Map the pasted Pharos CI failure to local reproduction and ownership. Do not edit files.

Read docs/testing.md, docs/deployment-process.md, docs/scripts.md, package.json scripts, and only the relevant adaptive-check or artifact-registry source.

Return: smallest repro; broader post-fix gate; likely source/scripts; affected docs; common false leads.
```
