# Agent 3 Sustainability and Maintainability Audit

Date: 2026-04-16
Scope: `/home/ahirice/Documents/git/stablecoin-dashboard`

## Assumptions And Scope

- "Full repository" means tracked source, shared data/schema code, worker runtime, Pages Functions, operational scripts, migrations, config, CI/CD, and verified documentation. Generated and ignored artifacts (`node_modules/`, `.next/`, `out/`, `coverage/`, local worktrees) were excluded except where config/CI explicitly references them.
- No product code was edited. This report is the only artifact created.
- The working tree already contained unrelated user changes before the audit (`shared/lib/redemption-backstop-configs/offchain-issuer.ts` plus several `agents/` notes). Those were not modified.

## Inventory

- Tracked files: 3,187.
- Major tracked surfaces: `worker/` 867 files (`worker/src` 831, migrations 25, `worker/scripts` 4), `src/` 660, `public/` 557, `shared/` 176, `scripts/` 60, `docs/` 60, `functions/` 16.
- Architecture from required docs: static Next.js 16 frontend exported to Cloudflare Pages; Pages Functions for same-origin site-data and ops-admin proxying; Cloudflare Worker + D1 for public, site-internal, and ops API lanes; runtime-neutral shared domain logic in `shared/`; D1 migrations applied before Worker promotion.
- Required docs reviewed: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`.

## Checks Run

| Area | Command / check | Result |
| --- | --- | --- |
| Dependency vulnerabilities | `npm audit --json --omit=dev`; `npm audit --json`; `npm audit --audit-level=high --omit=dev`; `npm audit --audit-level=high` | 0 vulnerabilities |
| Dependency drift | `npm outdated --json`; `npm outdated --workspaces --json`; targeted `npm outdated eslint-config-next ...` | Low drift only; see dependency table |
| Lockfile integrity | `npm ci --dry-run` | Passed |
| Lint/typecheck | `npm run lint`; `npm run typecheck`; `cd worker && npx tsc --noEmit` | Passed |
| Boundary/cycles | `npm run check:worker-boundary`; `npm run check:shared-cycles`; extra `madge` checks for `functions`, `scripts`, `worker/scripts` | No cycles; boundary check passed |
| Env/config docs | `npm run check:env-contract`; `.env.local` ignored check | Passed; `.env.local` ignored by `.gitignore` |
| Cron/migrations | `npm run check:cron-sync`; `npm run check:cron-connections`; `npm run check:migrations` | Passed |
| Docs | `npm run check:doc-sync`; `npm run check:doc-counts`; `npm run check:verified-doc-links` | Passed |
| Runtime guardrails | `npm run check:unused-code`; `npm run check:hotspot-ratchet`; `npm run check:duplicate-exports`; `npm run check:sql-safety` | Passed |
| Secret scan spot-check | tracked env/secret file check plus high-signal secret regex grep | No committed env secrets found; scheduled gitleaks workflow exists |

## Findings

### S1. Worker operational scripts are outside typecheck coverage and already have stale private imports

- Impact: High
- Scope:
  - `tsconfig.typecheck.json:3-18` includes root `scripts/**` but excludes all `worker/`.
  - `worker/tsconfig.json:20-21` includes only `worker/src/**` and `../shared/**`, not `worker/scripts/**`.
  - `docs/scripts.md:5` defines `worker/scripts/` as operational tooling that imports `worker/src/**`; `docs/scripts.md:44-53` documents production-affecting repair/reconcile scripts.
  - `worker/scripts/repair-non-usd-fiat-depeg-history.ts:18-37` imports admin helpers from old module surfaces; the current exports live in split modules such as `worker/src/api/backfill-depegs-extraction.ts:45-63` and `worker/src/api/backfill-depegs-preview.ts:9-90`, while `worker/src/api/backfill-fx.ts:1-9` imports `enumerateDates` from shared but does not re-export it.
  - The same script consumes those imports at `worker/scripts/repair-non-usd-fiat-depeg-history.ts:274`, `worker/scripts/repair-non-usd-fiat-depeg-history.ts:406`, `worker/scripts/repair-non-usd-fiat-depeg-history.ts:593`, and `worker/scripts/repair-non-usd-fiat-depeg-history.ts:729`.
- Issue: Incident/maintenance scripts can drift when worker internals are split. CI typechecks the Worker runtime and root scripts, but not the four worker-bound scripts. `npx tsc --listFilesOnly` for both configured typecheck paths showed no `worker/scripts` files.
- Long-term consequence: The repo can merge API/cron refactors that silently break production repair tools. The break is most likely discovered during an incident, when the script needs to be run.
- Remediation:
  - Add `worker/tsconfig.scripts.json` that extends `worker/tsconfig.json` and includes `scripts/**/*.ts` plus `src/**/*.ts` and `../shared/**/*.ts`.
  - Add a CI/local command, for example `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`.
  - Fix `repair-non-usd-fiat-depeg-history.ts` imports to the current extracted modules or move stable backfill helper contracts into a supported `worker/src/lib/admin-backfill/` surface.
  - Extend `check-worker-import-boundary` or add a worker-script boundary rule so operational scripts can use approved Worker lib APIs without importing route handlers as private implementation detail.

### S2. Deploy-impact classification omits supporting CI/guardrail code

- Impact: Medium
- Scope:
  - `scripts/lib/deploy-impact.mjs:18-49` lists exact deploy-impact files but omits `scripts/lib/deploy-impact.mjs` itself, `scripts/lib/validate-contract.mjs`, `.github/actions/setup-workspace/action.yml`, and several validate-gate scripts.
  - `scripts/classify-deploy-changes.mjs:49-68` uses that classification to decide whether the production workflow runs.
  - `.github/workflows/deploy-cloudflare.yml:17-45` feeds the classifier into deploy outputs; `.github/workflows/deploy-cloudflare.yml:47-53` skips the production workflow when `deploy_required` is false.
  - Probe result: `hasDeployImpact(["scripts/lib/deploy-impact.mjs"])`, `hasDeployImpact([".github/actions/setup-workspace/action.yml"])`, `hasDeployImpact(["scripts/check-cron-connection-budget.ts"])`, and `hasDeployImpact(["scripts/check-env-contract.mjs"])` all return false.
- Issue: Several files that directly shape validation/deploy behavior are treated like docs-only changes on push.
- Long-term consequence: A direct main push or a merged infrastructure-only PR can change the deploy decision machinery without exercising the production validation/deploy workflow on that commit. The next app deploy inherits unvalidated deploy logic.
- Remediation:
  - Add a small `CI_INFRA_CHANGE_PREFIXES` list including `scripts/lib/`, `.github/actions/`, and exact validate scripts that are invoked by `validate-ci.yml`.
  - Add regression tests in `scripts/__tests__/classify-deploy-changes.test.ts` for `scripts/lib/deploy-impact.mjs`, `.github/actions/setup-workspace/action.yml`, and representative guardrail scripts.
  - Consider generating the deploy-impact allowlist from `scripts/lib/validate-contract.mjs` and workflow references to reduce drift.

### S3. Deferred hotspot debt is tracked but still large in several change-heavy modules

- Impact: Medium
- Scope:
  - Waived hotspot backlog: `scripts/lib/hotspot-ratchet-waivers.json:2-20`, `scripts/lib/hotspot-ratchet-waivers.json:34-48`, `scripts/lib/hotspot-ratchet-waivers.json:78-88`.
  - Enrolled deferred hotspot: `scripts/lib/hotspot-ratchet-baseline.json:242-252`.
  - Largest relevant files observed:
    - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` - 1,000 lines.
    - `src/lib/coverage.ts` - 908 lines.
    - `src/app/stability-index/client.tsx` - 752 lines.
    - `worker/src/cron/dispatch-telegram-alerts.ts` - 670 lines, baseline max function 420 lines.
    - `src/components/contagion-graph.tsx` - 641 lines.
- Issue: The hotspot ratchet is healthy and prevents unreviewed growth, but multiple high-change domains remain intentionally deferred or queued. These modules still mix orchestration, policy, rendering, data shaping, and side effects.
- Long-term consequence: Future feature work in pricing, alerting, PSI, coverage, and dependency-map areas will continue to require broad context loading and risk regression across unrelated behavior.
- Remediation:
  - Treat the waiver file as a refactor queue, not only a ratchet exception list.
  - Prioritize Worker-side hotspots first: split primary pricing enrichment into provider-family phases and split Telegram dispatch into candidate selection, rendering, queueing, and delivery.
  - For UI hotspots, extract view-model hooks and pure transforms before component splitting so tests can cover behavior without rendering the full route.

### S4. Fetch-heavy cron lanes have little declared connection headroom

- Impact: Medium
- Scope:
  - Six-connection operating constraint: `docs/worker-and-api-limits.md:48-60`.
  - Budget model: `shared/lib/cron-jobs.ts:78-80` and `scripts/check-cron-connection-budget.ts:3-41`.
  - Current dense slots:
    - `shared/lib/cron-jobs.ts:138-165` quarter-hourly jobs declare 5/6 total.
    - `shared/lib/cron-jobs.ts:239-264` DEX/yield supplemental lanes include 4/6 and 5/6 fetch-heavy phases.
    - `shared/lib/cron-jobs.ts:359-392` daily 08:05 lane declares 4/6.
  - `npm run check:cron-connections` reported `quarterHourly` 5/6, `halfHourlyOffset` 5/6, `fourHourlyYieldSupplemental` 5/6, `daily0805Utc` 4/6.
- Issue: The scheduler is well documented and currently passes, but several lanes have only one or two declared spare connections. Sequential handlers reduce real peak in some slots, but the metadata and guardrail already show limited room for new providers.
- Long-term consequence: Adding another fetch-heavy provider to the easiest existing slot can push the Worker into connection contention or force later emergency rescheduling.
- Remediation:
  - Add a warning threshold in `check-cron-connection-budget.ts` for slots above 4/6, even when still passing.
  - Record both `declaredTotalConnections` and `peakConnections` for sequential slots so the budget model is precise.
  - Require any new provider PR to state its trigger slot, peak fetch count, timeout, and fallback behavior in `docs/worker-and-api-limits.md`.

### S5. Site-data fallback documentation is semantically inconsistent

- Impact: Low
- Scope:
  - `docs/api-reference.md:183` still says the Pages proxy can temporarily fall back to `api.pharos.watch` until the dedicated host is provisioned and says not to move `PUBLIC_API_AUTH_MODE` past `off` until `SITE_API_ORIGIN` is pointed at `site-api`.
  - `worker/wrangler.toml:15-18` already declares `site-api.pharos.watch`, and `worker/wrangler.toml:57-62` sets `PUBLIC_API_AUTH_MODE = "enforce"`.
  - `docs/deployment-process.md:220-226` and `docs/architecture.md:682-686` say production Pages hosts require `SITE_API_ORIGIN` and fail closed, with fallback limited to preview/local rehearsal.
- Issue: The verified docs pass exact-value checks, but the API reference still carries an outdated rollout-era warning.
- Long-term consequence: New operators can misread the current production invariant and either over-trust public API fallback or misunderstand why production site-data fails closed.
- Remediation:
  - Update `docs/api-reference.md:183` to match `docs/architecture.md:685`: production requires explicit `SITE_API_ORIGIN`; only preview/local rehearsal can fall back.
  - Update `docs/deployment-process.md:221` to remove "when provisioned" wording if `site-api.pharos.watch` is now a permanent configured host.
  - Add this semantic pair to `check-doc-sync.ts` if the fallback policy changes often.

### S6. Package-manager reproducibility is weaker than the rest of the CI contract

- Impact: Low
- Scope:
  - `.nvmrc:1` pins local Node major to `22`.
  - `package.json:9-10` and `worker/package.json:5-6` allow Node `>=22.12 <26`.
  - `.npmrc:1` has `save-exact=true`, but the root `package.json` has no `packageManager` field and local `engine-strict` is false.
  - CI runs `actions/setup-node` on Node 22, 24, and 25, using the npm bundled with each runner.
- Issue: Dependency contents are lockfile controlled, but npm behavior itself is not pinned. This is lower risk than unpinned dependencies, but it is inconsistent with the otherwise strict deployment tooling.
- Long-term consequence: Lockfile formatting, peer resolution, workspace behavior, and lifecycle hook behavior can vary across local Node/npm combinations.
- Remediation:
  - Add a root `packageManager`, for example `npm@<chosen-ci-version>`, and document the intended npm major.
  - Consider `engine-strict=true` if contributors frequently run unsupported Node versions.
  - Keep Node 24/25 compatibility lanes, but use a consistent npm version if package-manager drift becomes noisy.

### S7. Direct dependency drift is low-risk but includes deploy/runtime tooling

- Impact: Low
- Scope:
  - Root dependency metadata: `package.json:59-103`.
  - Worker dependency metadata: `worker/package.json:12-25`.
  - Dependabot policy: `.github/dependabot.yml:1-28`.
- Issue: `npm audit` is clean, and Dependabot is configured, but several direct packages have newer versions. Most are patch/minor drift; major drift for ESLint, TypeScript, and `@types/node` is intentionally ignored by Dependabot policy.
- Long-term consequence: Leaving Worker tooling patches (`wrangler`, `@cloudflare/workers-types`, `viem`) behind for long periods can make Cloudflare platform changes land as larger, riskier upgrade batches.
- Remediation:
  - Take routine patch/minor updates in small batches, prioritizing Worker deploy tooling.
  - Keep TypeScript 6 and ESLint 10 as explicit planned migrations, not background Dependabot noise.

## Dependency Audit Summary

| Package / area | Current | Latest observed | Audit status | Recommendation |
| --- | ---: | ---: | --- | --- |
| Production dependency advisories | n/a | n/a | 0 vulnerabilities via `npm audit --omit=dev` | No action |
| Full dependency advisories | n/a | n/a | 0 vulnerabilities via full `npm audit` | No action |
| `@cloudflare/workers-types` | 4.20260414.1 | 4.20260415.1 | Patch drift | Update with Worker smoke/typecheck |
| `wrangler` | 4.82.2 | 4.83.0 | Patch drift | Prioritize because deploy path depends on it |
| `viem` | 2.47.17 | 2.48.0 | Minor drift | Update with worker tests around RPC/contract helpers |
| `eslint-config-next` | 16.2.3 | 16.2.4 | Patch drift | Update with lint |
| `prettier` | 3.8.2 | 3.8.3 | Patch drift | Low priority |
| `@types/node` | 22.19.17 | 25.6.0 | Major drift | Intentional if Node 22 types remain canonical; revisit with Node baseline change |
| `eslint` | 9.39.4 | 10.2.0 | Major drift | Planned migration only |
| `typescript` | 5.9.3 | 6.0.2 | Major drift | Planned migration only; Next/Worker compatibility first |
| Lockfile | v3 | n/a | `npm ci --dry-run` passed | No immediate action |
| Top-level deprecation metadata | n/a | n/a | No npm deprecation surfaced in completed metadata checks | No immediate action |

## Roadmap

### Phase 1 - Quick Wins

| Finding | Action | Effort | Dependencies |
| --- | --- | --- | --- |
| S1 | Fix stale imports in `worker/scripts/repair-non-usd-fiat-depeg-history.ts`; add a worker-script typecheck command. | Small/Medium | None |
| S2 | Add missing CI/deploy support files to deploy-impact classification and tests. | Small | None |
| S5 | Align site-data fallback wording across API reference and deployment docs. | Small | None |
| S7 | Apply patch/minor updates for `wrangler`, `@cloudflare/workers-types`, `viem`, `eslint-config-next`, `prettier`. | Small | Validate/smoke gates |

### Phase 2 - Targeted Refactoring

| Finding | Action | Effort | Dependencies |
| --- | --- | --- | --- |
| S3 | Split primary pricing enrichment into provider-family stages with stable interfaces. | Medium | S1 if worker scripts reuse helpers |
| S3 | Split Telegram dispatch orchestration from payload rendering and delivery side effects. | Medium | Existing Telegram tests |
| S4 | Add cron warning threshold and model `peakConnections` separately from declared slot total. | Medium | None |

### Phase 3 - Structural Improvements

| Finding | Action | Effort | Dependencies |
| --- | --- | --- | --- |
| S3 | Extract route-level view models for PSI, coverage, and dependency-map UI hotspots. | Medium/Large | Stable UI tests |
| S6 | Pin package manager and document npm version policy. | Small | Team agreement on npm major |

### Phase 4 - Strategic Overhauls

No strategic re-architecture is warranted from this sustainability pass. The main architecture is coherent: Worker/Page/shared boundaries pass, cycle checks pass, env contracts are explicit, migrations are replayed, and deploy smoke coverage is strong.

## Positive Sustainability Signals

- Worker/shared/frontend cycles: none detected in configured guardrails and supplemental `madge` checks.
- Runtime boundary checks: passed.
- Environment contract: `.env.example` aligns with Worker and Pages env contracts; `.env.local` is ignored.
- D1 migration safety: 24 migrations replayed locally; rollout-safety headers enforced for post-baseline migrations.
- CI/CD: strong validate gate, Worker preview smoke before promotion, post-promotion API smoke, automatic rollback, Pages artifact smoke, live UI smoke, ops smoke, transport smoke, CodeQL, scheduled dependency audit, and scheduled history-aware gitleaks scan.
- Documentation guardrails: doc counts, exact method/version sync, and verified links passed.
