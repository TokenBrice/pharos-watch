# Docs Archivist First Iteration

Date: 2026-04-24
Branch: local `main`

## Scope

Five read-only GPT-5.5 xhigh reviewer agents covered API artifacts, methodology/pipeline docs, worker/ops/testing docs, product/page docs, and agent-facing source maps. Local guardrails also passed before edits: verified doc links, doc source paths, doc counts, doc sync, llms.txt, OpenAPI, Postman, cron sync, and cron connection budget.

## Accepted Corrections

- API method validation: clarified unknown `GET` versus unknown `POST` behavior in `docs/api-reference.md`.
- API artifacts: added `usds-status` and `bluechip-ratings` to OpenAPI generation, and added missing public endpoints to the Postman collection generator.
- Worker/ops docs: corrected monthly yield-audit runner mapping and documented merge-gate's common postbuild test/coverage phase.
- Testing docs: added `cache-passthrough` to the critical-contracts suite inventory.
- Product docs: corrected homepage freshness/error surface order and portfolio URL-vs-storage persistence semantics.
- Methodology docs: documented the list-aggregator price-confidence downgrade, corrected `burn_type` values, and updated yield on-chain rate and variant-map inventories.
- Agent map: regenerated `docs/agent-code-map.md` from a clean `HEAD` snapshot with the checked-in source map generator, avoiding the unrelated dirty visualization edits in the local workspace.

## Not Included

- The alt-pegs responsive-atlas doc finding was already entangled with pre-existing dirty visualization work in the local workspace. It was not staged in this doc commit because committing that doc without the matching dirty code would make `origin/main` less accurate.
