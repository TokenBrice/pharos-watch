# Tier 1 Deploy Optimizations Plan

Date: 2026-03-21

## Goal

Implement the Tier 1 deploy/workflow improvements from the testing and deployment audit:

1. Skip Pages build/smoke/deploy on worker-only pushes.
2. Split the scheduled rebuild into a Pages-only workflow.
3. Add concurrency cancellation for deploy workflows.

## Steps

1. Extend `scripts/classify-deploy-changes.mjs` to compute both `worker_changed` and `pages_changed`, and add tests for the new path classification.
2. Update `.github/workflows/deploy-cloudflare.yml` so push/manual deploys branch cleanly between worker-only, Pages-only, and combined deploy paths.
3. Add a separate scheduled Pages rebuild workflow that runs build, local browser smoke, Pages deploy, and ops smoke without redeploying the worker or rerunning full validate.
4. Update the deployment/testing/scripts docs to reflect the new workflow split and gating behavior.
5. Verify with build, lint, full tests, worker type-check, and targeted classifier checks.
