# Worker Import Boundary Waivers

Pharos enforces a strict layering rule: code under `worker/src/` must not import from `src/` or `@/`, and code under `src/`, `shared/`, `scripts/`, or `functions/` must not import from `worker/src/`.

Enforcement is part of the ESLint configuration and runs on every changed file:

- **frontend→worker** — a `no-restricted-imports` block in `eslint.config.mjs`, so the rule runs on every changed file through `lint:changed` rather than only when a worker file also moves.
- **worker→frontend** — the `pharos/worker-import-boundaries` custom rule in `eslint.config.mjs`, which bans frontend specifiers from `worker/src/`.

The sole reviewed frontend→worker waiver is listed in `FRONTEND_TO_WORKER_WAIVED_FILES` in `eslint.config.mjs`. Every exempt file MUST have an entry below explaining why retirement is not feasible today.

## Active Waivers

### 1. `scripts/ci/check-frozen-invariants.ts`

- **Waiver ID:** `frozen-invariants-lifecycle-registry-check`
- **Status:** Long-lived. No active retirement plan.
- **Reason:** The freeze runbook requires asserting that frozen stablecoin IDs are absent from every independent registry that participates in lifecycle surfaces — worker-side registries (`MINT_BURN_CONFIG_SPECS`, `CONTRACT_CONFIGS`, `YIELD_POOL_MAP`) and the frontend `STATIC_COMPARE_PAIRS` fixture. The check is intentionally cross-layer because that is exactly what it validates.
- **What was tried:** Promoting the source registries into `shared/` was evaluated:
  - `MINT_BURN_CONFIG_SPECS` references `chainConfig()` and helper closures (`transferMintBurn`, `ccipBridgeDetection`, etc.) that resolve worker-side `tracked-contract-resolution` data. Splitting an ID-only mirror would either duplicate the source of truth or invert dependency direction across 10+ worker modules.
  - `CONTRACT_CONFIGS` is constructed from `CONTRACT_CONFIG_SPECS` via `resolveBlacklistContractConfig`, which uses the same worker-resolution path.
  - `YIELD_POOL_MAP` is a pure `Record<string,string>` but has 10+ worker-side consumers; moving it to `shared/` would touch every yield cron module without changing the boundary surface (the script would still need the mint-burn and blacklist worker imports).
  - In each case the refactor expands the change surface dramatically without removing the architectural exception.
- **Mitigations:**
  - The waiver list in `eslint.config.mjs` contains only this reviewed file; adding another requires a documented architectural review on this page.
  - The script header comment names the waiver and points to this document.
  - The script is build-time only (it never ships in any deployed bundle), so the cross-layer import has no runtime impact.
- **Retirement plan:** None. The waiver is acceptable as long as it remains a single build-time validator and the registries remain worker-resident.

## Adding a Waiver

1. Confirm the cross-layer import cannot be replaced by promoting metadata into `shared/`.
2. Add the path to `FRONTEND_TO_WORKER_WAIVED_FILES` in `eslint.config.mjs` with a one-line reason in the rule configuration.
3. Add a section to this document explaining the file, reason, what was tried, mitigations, and retirement plan (or "permanent").
4. Update the focused ESLint boundary coverage when the rule behavior changes.
