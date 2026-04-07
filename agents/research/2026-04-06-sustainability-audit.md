# Sustainability And Maintainability Audit

Date: 2026-04-06
Repo: `stablecoin-dashboard`
Scope: `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, `.github/workflows`, docs/config, root and worker manifests/lockfiles

## Impact Tally

| Impact | Count |
| --- | ---: |
| High | 3 |
| Medium | 5 |
| Low | 1 |
| **Total** | **9** |

## System-Level Summary

The repo has a solid baseline: lockfiles are present, `npm audit` is clean at `high` and above for both prod-only and full installs, CI is broader than most dashboards, and the docs corpus is substantial. The maintainability risk is concentrated instead in a small number of worker and frontend hotspots plus a few process gaps that let those hotspots keep growing.

The highest-confidence structural issues are:

1. import-cycle enforcement only covers `shared/`, while real cycles already exist in `worker/src/`
2. hotspot governance is static and misses several of the largest active runtime files
3. the `sync-stablecoins` worker split still behaves like a tightly coupled subsystem instead of cleanly separated stages
4. security-sensitive and ingestion-heavy modules remain concentrated into large multi-role files
5. the verified docs/config surface has measurable drift from the live runtime contract

Dependency health note:

- `package-lock.json` and `worker/package-lock.json` are present.
- `npm audit --audit-level=high --omit=dev` and `npm audit --audit-level=high` returned no confirmed vulnerabilities.
- `npm outdated` showed normal upgrade pressure, but no immediate maintainability blocker strong enough to elevate into a finding.

## Findings

### S1. CI and local gates do not check `worker/src/` or `src/` for cycles, and worker cycles already exist
- Impact: High
- Location:
  - guardrail scope:
    - `scripts/check-shared-cycles.mjs:5`
    - `docs/testing.md:16`
  - confirmed current cycles:
    - `worker/src/lib/live-reserves-store-shared.ts:10`
    - `worker/src/lib/live-reserves-store-parsing.ts:23-28`
    - `worker/src/cron/sync-stablecoins/stages.ts:9-10,26-30`
    - `worker/src/cron/sync-stablecoins/fallback.ts:2-5,27-32`
    - `worker/src/cron/sync-stablecoins/intake.ts:8-14`
    - `worker/src/cron/sync-stablecoins/runtime.ts:1-2`
- Description:
  - The documented cycle check only covers `shared/`, even though the worker is the heaviest architectural surface in the repo.
  - A targeted import-graph scan during this audit found concrete worker cycles in both `live-reserves` and `sync-stablecoins`.
- Long-term consequence:
  - Module initialization order stays fragile in production worker code, and future refactors keep inheriting hidden coupling without any CI feedback.
- Recommended remediation:
  - Replace `check:shared-cycles` with a repo-level import-cycle check, or add dedicated `worker/src` and `src` cycle gates.
  - Clean up the current worker cycles before enabling CI failure for the broader scope.

### S2. The `sync-stablecoins` subsystem is split across files but still behaves like a tightly coupled monolith
- Impact: High
- Location:
  - `worker/src/cron/sync-stablecoins.ts:66-208`
  - `worker/src/cron/sync-stablecoins/stages.ts:431-574`
  - `worker/src/cron/sync-stablecoins/fallback.ts:124-356`
  - `worker/src/cron/sync-stablecoins/stages.ts:9-10,26-30`
  - `worker/src/cron/sync-stablecoins/fallback.ts:2-5,27-32`
  - `worker/src/cron/sync-stablecoins/intake.ts:8-14`
  - `worker/src/cron/sync-stablecoins/runtime.ts:1-2`
- Description:
  - The subsystem has been split into `stages`, `fallback`, `intake`, and `runtime`, but responsibility boundaries remain blurred enough to create back-edges and duplicated orchestration.
  - The main and fallback flows still coordinate similar validation, enrichment, cache publication, and depeg work from different entry surfaces.
- Long-term consequence:
  - This remains expensive to change safely. Pipeline changes will keep carrying high regression cost because the current file split does not map cleanly to stable architectural ownership.
- Recommended remediation:
  - Re-center the subsystem around one publish pipeline with strategy-based intake.
  - Move shared contracts and pure helpers into leaf modules that `stages`, `fallback`, and `intake` can depend on without depending on each other.

### S3. Hotspot governance misses several current top-risk files
- Impact: High
- Location:
  - guardrail definition:
    - `scripts/lib/hotspot-ratchet.mjs:5-39`
  - large runtime files not covered by that allowlist:
    - `worker/src/lib/api-keys.ts:15-839`
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:102-807`
    - `worker/src/cron/yield-sync/resolve.ts:154-789`
    - `worker/src/cron/sync-yield-data.ts:226-380`
    - `src/components/stablecoin-table.tsx:181-700`
    - `src/app/stability-index/client.tsx:570-756`
    - `src/app/admin/client.tsx:120-537`
- Description:
  - The hotspot ratchet only protects a fixed nominated list.
  - Several of the repo’s current largest runtime files sit outside that list entirely, so they can keep growing without any decomposition pressure in CI.
- Long-term consequence:
  - Maintainability governance becomes stale: older hotspots are watched while newer ones silently absorb complexity.
- Recommended remediation:
  - Generate hotspot candidates from file metrics on every run and require an explicit disposition for any oversized runtime file.
  - Keep the allowlist only as an override layer, not the source of truth.

### S4. `worker/src/lib/api-keys.ts` is a multi-responsibility module in a security-sensitive area
- Impact: Medium
- Location:
  - `worker/src/lib/api-keys.ts:15-839`
  - representative responsibility spans:
    - `worker/src/lib/api-keys.ts:211-254`
    - `worker/src/lib/api-keys.ts:336-389`
    - `worker/src/lib/api-keys.ts:391-455`
    - `worker/src/lib/api-keys.ts:474-839`
- Description:
  - One file owns token parsing, cryptographic derivation, auth checks, pepper rotation handling, rate limiting, usage bookkeeping, audit logging, and admin CRUD paths.
- Long-term consequence:
  - Review quality, isolation testing, and future auth/rate-limit changes all get harder in one of the repo’s most operationally sensitive subsystems.
- Recommended remediation:
  - Split into focused modules for token handling, auth, rate limits, admin persistence, and audit logging.
  - Keep a thin facade only if a single public import surface is still valuable.

### S5. Yield publication is concentrated in large orchestration modules
- Impact: Medium
- Location:
  - `worker/src/cron/yield-sync/resolve.ts:154-789`
  - `worker/src/cron/sync-yield-data.ts:226-380`
- Description:
  - The yield path mixes source resolution, safety gating, TVL thresholds, timed optional providers, historical lookups, advisory logging, cache parsing, cooldown handling, and publication state management in a small number of files.
- Long-term consequence:
  - New provider work and safety logic will keep colliding in the same modules, which increases merge friction and makes source additions disproportionately risky.
- Recommended remediation:
  - Split resolver logic by source family and move publication-state concerns into a separate orchestration layer.
  - Keep `sync-yield-data.ts` focused on scheduling and result publication.

### S6. Stablecoin price enrichment is concentrated in one provider-heavy integration hub
- Impact: Medium
- Location:
  - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:102-807`
  - major sections:
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:102-335`
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:347-432`
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:445-557`
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:571-734`
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:738-807`
- Description:
  - Provider clients, identity resolution, chain normalization, budget enforcement, and fallback business rules all live in one module.
- Long-term consequence:
  - Every new provider or fallback-order change broadens the blast radius across unrelated enrichment logic.
- Recommended remediation:
  - Split by provider family plus one shared identity/budget module.
  - Leave only sequencing and pass ordering in a small coordinator file.

### S7. `.env.example` no longer matches the actual worker env contract
- Impact: Medium
- Location:
  - runtime contract:
    - `worker/src/lib/env.ts:7-45`
    - `worker/src/lib/env.ts:56-93`
  - example file:
    - `.env.example:21-77`
- Description:
  - `.env.example` omits bindings that the runtime contract explicitly supports, including:
    - `SITE_API_SHARED_SECRET_PREVIOUS`
    - `API_KEY_HASH_PEPPER`
    - `API_KEY_HASH_PEPPER_PREVIOUS`
    - `PUBLIC_API_AUTH_MODE`
    - `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
    - `CLOUDFLARE_D1_STATUS_API_TOKEN`
    - `CLOUDFLARE_D1_DATABASE_ID`
- Long-term consequence:
  - Onboarding, secret rotation, and operator debugging become less reliable than the code contract implies.
- Recommended remediation:
  - Generate `.env.example` from the canonical env contract, or add a CI check that diffs the example file against `worker/src/lib/env.ts`.

### S8. The verified documentation corpus contains active path and configuration drift
- Impact: Medium
- Location:
  - broken hotspot backlog path:
    - `docs/testing.md:202`
    - actual file: `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md`
  - wrong frontend env var name:
    - `README.md:113-114`
    - actual env usage:
      - `.env.example:10-16`
      - `src/lib/api.ts:12`
      - `src/lib/api.ts:30`
- Description:
  - `docs/testing.md` points to a non-existent plan path.
  - `README.md` instructs developers to use `NEXT_PUBLIC_API_BASE_URL`, while the runtime reads `NEXT_PUBLIC_API_BASE`.
- Long-term consequence:
  - The repo’s “verified documentation corpus” becomes less trustworthy and causes avoidable setup/debugging friction.
- Recommended remediation:
  - Add doc-link validation for internal repo links and a small env-name consistency check covering README, `.env.example`, and runtime code.

### S9. Generated worker build output is not fully ignored
- Impact: Low
- Location:
  - ignore rules:
    - `.gitignore:19-21`
    - `.gitignore:95-103`
  - generated scope currently visible in worktree:
    - `worker/.next/`
- Description:
  - The repo ignores root `.next/` and worker `.wrangler/`, but not `worker/.next/`.
- Long-term consequence:
  - Normal local worker build activity dirties the worktree and increases accidental commit/review noise.
- Recommended remediation:
  - Add `worker/.next/` to the worker artifact section of `.gitignore`.

## Recommended Remediation Order

1. `S8` and `S9`: fix documentation/config drift and ignore rules immediately. These are small and remove daily friction.
2. `S7`: align `.env.example` with the live worker env contract before the next secret rotation or onboarding cycle.
3. `S1`: remove current worker cycles, then broaden CI/import graph enforcement.
4. `S2` and `S3`: restructure the `sync-stablecoins` subsystem and make hotspot governance dynamic so the same complexity pattern does not re-accumulate.
5. `S4`, `S5`, and `S6`: decompose the major worker hotspots in security and ingestion pipelines once guardrails are in place.
