# Worker Import Boundary Waivers

Pharos enforces a strict layering rule: code under `worker/src/` must not import from `src/` or `@/`, and code under `src/`, `shared/`, `scripts/`, or `functions/` must not import from `worker/src/`.

Enforcement is split across two mechanisms:

- **frontend→worker** — a `no-restricted-imports` block in `eslint.config.mjs`, so the rule runs on every changed file through `lint:changed` rather than only when a worker file also moves.
- **worker→frontend** — `scripts/ci/check-worker-import-boundary.mjs`, which bans *any* `@/` or `src/` specifier from `worker/src/` (broader than the enumerable `src/lib/*` shapes ESLint lists) and runs as part of the shared validation gate.

Files listed in `BOUNDARY_WAIVERS` inside the checker are exempt from this rule. Every exempt file MUST have an entry below explaining why retirement is not feasible today, and MUST also appear in `FRONTEND_TO_WORKER_WAIVED_FILES` in `eslint.config.mjs` — the checker's `checkEslintWaiverSync()` fails when the two lists drift apart.

`MAX_BOUNDARY_WAIVERS` caps the size of the waiver list. Growing the cap is an architectural decision that requires a documented review on this page.

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
  - The waiver list is capped at `MAX_BOUNDARY_WAIVERS = 1`. Adding a second waiver requires bumping the cap and adding an entry here.
  - `scripts/__tests__/worker-boundary-waivers.test.ts` asserts the waiver list matches this document (waiver IDs, files, and cap stay in sync).
  - The script header comment names the waiver and points to this document.
  - The script is build-time only (it never ships in any deployed bundle), so the cross-layer import has no runtime impact.
- **Retirement plan:** None. The waiver is acceptable as long as it remains a single build-time validator and the registries remain worker-resident.

## Adding a Waiver

1. Confirm the cross-layer import cannot be replaced by promoting metadata into `shared/`.
2. Append an entry to `BOUNDARY_WAIVERS` in `scripts/ci/check-worker-import-boundary.mjs` with a one-line reason, and add the same path to `FRONTEND_TO_WORKER_WAIVED_FILES` in `eslint.config.mjs`.
3. Bump `MAX_BOUNDARY_WAIVERS` and document the new cap.
4. Add a section to this document explaining the file, reason, what was tried, mitigations, and retirement plan (or "permanent").
5. Update `scripts/__tests__/worker-boundary-waivers.test.ts` to cover the new entry.
