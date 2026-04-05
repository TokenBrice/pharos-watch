# Sustainability and Maintainability Audit

Scope note: this Agent 3 pass covers sustainability / maintainability only. I did not re-run redundancy-elimination or code-quality findings in this report.

## 1. Executive Summary

Findings in scope: 4 total, all Medium impact. No High or Critical maintainability findings were identified in this pass.

Top issues, ordered by remediation leverage:

1. Shared CI/workflow scaffolding is repeated across five workflow files, so routine pipeline changes still require coordinated edits in multiple YAMLs.
2. The HTTP routing boundary is intentionally centralized, but the route registry plus dependency hydrator form a large hand-maintained assembly surface that will get harder to evolve as endpoints grow.
3. The live-reserve adapter inventory is stale in canonical docs, and the repo-local doc-count guard is already flagging the mismatch.
4. The deployment/testing docs do not fully describe the current shared validate contract because they omit `npm run audit:pricing-providers`, even though the contract and CI both run it.

Overall maintainability rating: 7/10. The codebase has strong guardrails, explicit contracts, and a healthy amount of automation, but the maintenance burden is concentrated in docs/workflow glue and a few central orchestration surfaces.

Estimated technical debt footprint: about 7% of the repo surface is affected by significant maintainability issues, concentrated in docs, workflow definitions, and routing glue rather than runtime business logic.

Verification used for this pass: `npm run check:unused-code`, `npm run check:shared-cycles`, `npm run check:worker-boundary`, `npm run check:cron-sync`, `npm run check:migrations`, `npm run check:duplicate-exports`, `npm run check:hotspot-ratchet`, `npm audit --audit-level=high --omit=dev`, and `npm run check:doc-counts` (which failed on the stale adapter-count docs, confirming one finding).

## 2. Findings by Pillar

### Sustainability and Maintainability

**M1. Live-reserve inventory drift in canonical docs**

Impact: Medium. Scope: [shared/lib/live-reserve-adapters.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/live-reserve-adapters.ts#L255) lines 255-556; [worker/src/cron/reserve-adapters/index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/index.ts#L41) lines 41-97; [docs/live-reserves.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md#L12) line 12; [docs/architecture.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md#L483) line 483.

Problem: the authoritative live-reserve registry now defines 33 adapters, but both primary docs still say 32. `npm run check:doc-counts` already fails on this mismatch.

Why it matters: the docs are used as the human-facing inventory for live reserve coverage. When the count lags the source, onboarding, review, and feature planning all start from a false model of the current system.

Remediation: update the adapter count in both docs, refresh the architecture file-tree comment, and rerun `npm run check:doc-counts` so the docs and source stay aligned.

**M2. Validation contract docs omit a CI-enforced check**

Impact: Medium. Scope: [scripts/lib/validate-contract.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/validate-contract.mjs#L1) lines 1-32; [.github/workflows/validate-ci.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/validate-ci.yml#L24) lines 24-76; [docs/deployment-process.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md#L56) lines 56-79; [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md#L47) lines 47-67.

Problem: the shared validate contract and CI workflow both run `npm run audit:pricing-providers`, but the deployment-process and testing docs do not mention it in the validate checklist.

Why it matters: this creates a silent documentation gap between the local mental model and the actual gate. Contributors can believe they have reproduced the full pre-push or PR contract when they have not.

Remediation: add `npm run audit:pricing-providers` to the validate checklist in both docs, or derive the checklist text from `scripts/lib/validate-contract.mjs` so the docs cannot drift from the contract.

**M3. Repeated workflow scaffolding across Pages and deploy jobs**

Impact: Medium. Scope: [.github/workflows/validate-ci.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/validate-ci.yml#L24) lines 24-102; [.github/workflows/pages-prepare.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-prepare.yml#L20) lines 20-97; [.github/workflows/pages-publish.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-publish.yml#L15) lines 15-57; [.github/workflows/deploy-cloudflare.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml#L14) lines 14-260; [.github/workflows/pages-release.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-release.yml#L20) lines 20-33; [.github/workflows/rebuild-pages.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/rebuild-pages.yml#L15) lines 15-46.

Problem: the checkout/setup-node/cache/npm-ci pattern and the smoke-step patterns are repeated across multiple workflows and jobs. The repo uses reusable workflows in places, but the common scaffolding is still duplicated enough that edits must be coordinated manually.

Why it matters: any change to Node versions, cache keys, artifact handling, or smoke env variables requires touching several YAML files. That is a classic drift surface for CI and release pipelines.

Remediation: extract the common setup and smoke behavior into a smaller reusable workflow or composite action, leaving the top-level workflows to handle only orchestration and gating.

**M4. Route registry and dependency hydration are one large manual assembly surface**

Impact: Medium. Scope: [worker/src/route-registry.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/route-registry.ts#L83) lines 83-335; [worker/src/handlers/http/context.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/context.ts#L11) lines 11-71.

Problem: the HTTP routing boundary is safe and type-checked, but it is still centralized into a broad manual registry and a separate dependency-hydration table. Adding or changing an endpoint usually means touching shared endpoint metadata, route registration, context hydration, and often tests or docs.

Why it matters: this is the main scaling bottleneck for future API surface growth. The pattern works now, but every additional route increases the maintenance cost of the central switchboard.

Remediation: split route registration and hydration by domain so each API family owns a smaller registry, or generate the hydration layer from endpoint metadata so the per-route maintenance surface shrinks.

## 3. Cross-Cutting Concerns

The repo relies heavily on explicit synchronization between source, docs, and CI contracts. M1 and M2 show that the source of truth is strong, but the human-readable layer still drifts when counts or validate steps change.

M3 and M4 are the same class of problem at different layers: centralized glue is well guarded, but the cost of making a change grows because the coordination surface is broad and partly manual.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

- M1: Update the live-reserve adapter counts in `docs/live-reserves.md` and `docs/architecture.md`, plus the architecture file-tree comment. Affected files: `shared/lib/live-reserve-adapters.ts`, `worker/src/cron/reserve-adapters/index.ts`, `docs/live-reserves.md`, `docs/architecture.md`. Effort: small. Dependency: none.
- M2: Add `npm run audit:pricing-providers` to the validate checklist in `docs/deployment-process.md` and `docs/testing.md`, or replace the hardcoded list with a generated snippet from `scripts/lib/validate-contract.mjs`. Affected files: `scripts/lib/validate-contract.mjs`, `docs/deployment-process.md`, `docs/testing.md`. Effort: small. Dependency: none.

### Phase 2 - Targeted Refactoring

- M3: Extract the repeated checkout/setup/cache/npm-ci/smoke scaffolding into a reusable workflow or composite action. Affected files: `.github/workflows/validate-ci.yml`, `.github/workflows/pages-prepare.yml`, `.github/workflows/pages-publish.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`, `.github/workflows/deploy-cloudflare.yml`. Effort: medium. Dependency: Phase 1 docs cleanup is optional but keeps review noise lower.

### Phase 3 - Structural Improvements

- M4: Split the HTTP route registry and dependency hydration by domain so the main dispatcher no longer carries the entire API surface in one file. Affected files: `worker/src/route-registry.ts`, `worker/src/handlers/http/context.ts`, and the route metadata they consume in `shared/lib/api-endpoints.ts`. Effort: large. Dependency: none, but it is easier to do after any route-family additions are paused.

### Phase 4 - Strategic Overhauls

- None identified in this pass. The current system does not need a rewrite; it needs better synchronization and smaller orchestration seams.

## 5. Appendices

### File-by-File Finding Index

| File | Finding refs |
| --- | --- |
| `shared/lib/live-reserve-adapters.ts` | M1 |
| `worker/src/cron/reserve-adapters/index.ts` | M1 |
| `docs/live-reserves.md` | M1 |
| `docs/architecture.md` | M1 |
| `scripts/lib/validate-contract.mjs` | M2 |
| `.github/workflows/validate-ci.yml` | M2, M3 |
| `docs/deployment-process.md` | M2 |
| `docs/testing.md` | M2 |
| `.github/workflows/pages-prepare.yml` | M3 |
| `.github/workflows/pages-publish.yml` | M3 |
| `.github/workflows/deploy-cloudflare.yml` | M3 |
| `.github/workflows/pages-release.yml` | M3 |
| `.github/workflows/rebuild-pages.yml` | M3 |
| `worker/src/route-registry.ts` | M4 |
| `worker/src/handlers/http/context.ts` | M4 |

### Dependency Audit Summary

| Surface | Result | Notes |
| --- | --- | --- |
| Root production dependencies | Healthy | `npm audit --audit-level=high --omit=dev` reported 0 vulnerabilities. |
| Root + worker workspace manifests | Healthy | No repo-level dependency-health defect surfaced from the source manifests. |
| CI dependency posture | Healthy | `validate-ci.yml` runs `npm run audit:deps`, and the scheduled dependency audit covers devDependencies separately. |
| Runtime engine range | Stable | Repo targets Node `>=22 <25`; CI exercises 22.x and 24.x. |

### Glossary

| Term | Meaning |
| --- | --- |
| Reusable workflow | A GitHub Actions workflow invoked by another workflow via `workflow_call` instead of duplicating the job inline. |
| Composite action | A reusable action wrapper for repeated shell/setup steps in GitHub Actions. |
| Route registry | The central mapping from endpoint metadata to handler functions in the Worker. |
| Dependency hydration | The step that loads only the env and runtime fields a given route actually needs. |
| Contract docs | Checked-in docs that are treated as part of the verified operational surface, not as informal notes. |

