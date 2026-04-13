# Reserve Audit Remediation — Implementation Plan

**Date:** 2026-04-08
**Scope:** Data accuracy fixes, adapter code quality, core sync fixes, frontend hardening, live coverage expansion, integration tests.
**Excludes:** usr-resolv, susd-synthetix (per user request).

---

## Execution Model

4-wave subagent pipeline. Each wave runs after the prior wave's agents complete. Within a wave, all agents run in parallel on disjoint file sets.

### Wave 1 — Fix existing code (4 parallel agents)

**No file overlap between agents. All touch only existing files.**

### Wave 2 — Expand live reserve coverage (3 agents, serialized where needed)

**Agent 2-E runs in parallel with Agent 2-F. Agent 2-H runs after 2-F (shares type/registry files).**

### Wave 3 — Complex adapter upgrade (1 agent)

**Depends on Wave 2 (adapter infrastructure may have changed).**

### Wave 4 — Verification (sequential)

**Integration tests, then merge gate. Depends on all prior waves.**

---

## Wave 1: Fix Existing Code

### Agent 1-A: Data Accuracy Fixes + ylds-figure Config

**Files:** `shared/data/stablecoins/usd-major.json`, `shared/data/stablecoins/usd-minor.json`, `shared/data/stablecoins/non-usd.json`

This agent owns ALL edits to the stablecoin JSON data files in Wave 1. It also handles the ylds-figure config-only addition since that coin lives in `usd-major.json` (which this agent already touches for risk tag/coinId fixes).

#### Task 1-A-1: Fix USDD USDT risk tag
- **File:** `shared/data/stablecoins/usd-major.json`
- **Coin:** `usdd-tron-dao-reserve`
- **Change:** In the reserve slice named `"USDT (direct vaults)"`, change `"risk": "high"` → `"risk": "low"`.
- **Rationale:** USDT is canonically `low` in `shared/lib/reserve-asset-risk.ts`. The `high` tag is a data error.

#### Task 1-A-2: Fix cUSD USDC percentage
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `cusd-celo`
- **Change:** In the reserve slice named `"USDC (Circle stablecoin)"` (or similar USDC slice), change `"pct": 1` → `"pct": 2`.
- **Rationale:** cUSD and cEUR share the same Mento reserve. cEUR has USDC at 2%. cUSD sums to 99% — this fixes it to 100%.

#### Task 1-A-3: Fix apxUSD T-bill risk tag
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `apxusd-apyx`
- **Change:** In the reserve slice named `"U.S. Treasury Bills (liquidity buffer)"`, change `"risk": "low"` → `"risk": "very-low"`.
- **Rationale:** Direct T-bills are consistently tagged `very-low` across the codebase.

#### Task 1-A-4: Fix gold risk inconsistencies
- **File:** `shared/data/stablecoins/usd-minor.json` — coin `usdkg-gold-dollar`: slice `"Physical gold (LBMA Good Delivery bars)"`, change `"risk": "low"` → `"risk": "very-low"`.
- **File:** `shared/data/stablecoins/non-usd.json` — coin `isc-international-stable-currency`: slice `"Physical gold holdings"`, change `"risk": "low"` → `"risk": "very-low"`.
- **Rationale:** All commodity-file gold reserves use `very-low`. These two outliers should match.

#### Task 1-A-5: Fix frxUSD 0% USDC slice
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `frxusd-frax`
- **Change:** Remove the reserve slice with `"pct": 0` for USDC. A 0% slice is meaningless for display and scoring. The `coinId` dependency link can be preserved via the coin's `dependencies` field if needed, but check first — if `frxusd-frax` already has USDC in its `dependencies`, just delete the 0% slice.

#### Task 1-A-6: Add 12 missing coinId links
For each entry below, add a `"coinId"` field to the matching reserve slice. Do NOT change `pct`, `risk`, or `name`.

| File | Coin ID | Slice name (match by name) | Add coinId |
|------|---------|---------------------------|------------|
| usd-major.json | `usdf-falcon` | "Tokenized Treasuries (USTB)" | `"ustb-superstate"` |
| usd-major.json | `u-united-stables` | "USD1 (WLFI stablecoin)" | `"usd1-world-liberty-financial"` |
| usd-minor.json | `usdz-anzen` | Slice mentioning "USTB" | `"ustb-superstate"` |
| usd-minor.json | `cusd-celo` | "EURC (Circle euro stablecoin)" or similar EURC slice | `"eurc-circle"` |
| usd-minor.json | `dusd-dtrinity` | Slice mentioning "sUSDS" or "Sky Savings" | `"usds-sky"` |
| usd-minor.json | `dusd-dtrinity` | Slice mentioning "sfrxUSD" or "Curve AMO" | `"frxusd-frax"` |
| usd-minor.json | `ftusd-flying-tulip` | Slice mentioning "USDC" | `"usdc-circle"` |
| usd-minor.json | `ftusd-flying-tulip` | Slice mentioning "USDT" | `"usdt-tether"` |
| non-usd.json | `ceur-celo` | "EURC (Circle euro stablecoin)" or similar EURC slice | `"eurc-circle"` |
| non-usd.json | `silk-shade-protocol` | Slice mentioning "USDC" or "stablecoin" | `"usdc-circle"` |
| non-usd.json | `zchf-frankencoin` | Slice mentioning "PAXG" or "gold tokens" | `"paxg-paxos"` |
| non-usd.json | `deuro-deuro` | Slice mentioning "XAUT" | `"xaut-tether"` |

#### Task 1-A-7: Add ylds-figure curated-validated config
- **File:** `shared/data/stablecoins/usd-major.json`
- **Coin:** `ylds-figure`
- **Adapter:** `curated-validated` — YLDS is on Solana/Provenance only (no EVM). No on-chain EVM supply probe possible.
- **Config:** Add `liveReservesConfig`:
  - `"adapter": "curated-validated"`
  - `"version": 1`
  - `"semantics": "single-asset"`
  - `"breakerScope": "ylds-figure"`
  - `"display": { "url": "https://www.figure.com/yield-dollar", "label": "Figure Markets" }`
  - `"inputs": { "primary": { "kind": "http-json", "url": "https://markets.figure.com" } }` — verify API exists first; if no public JSON endpoint is discoverable, use a dummy URL and document in the commit that it needs manual verification.

**Verification:** After all changes, run `npm test` to ensure reserve validation tests pass (schema validation, risk consistency, coinId validation tests).

---

### Agent 1-B: Worker Adapter Code Quality

**Files:** `worker/src/cron/reserve-adapters/{infinifi,reservoir,sgforge-coinvertible,re-metrics,anzen-usdz,crvusd}.ts`, `worker/src/cron/reserve-adapters/slice-math.ts`

#### Task 1-B-1: Standardize input validation in infinifi.ts
- **File:** `worker/src/cron/reserve-adapters/infinifi.ts`
- **Change:** Replace the manual `isHttpJsonInput()` check + throw with `requireJsonInputFromConfig(config, "infinifi")`.
- Import `requireJsonInputFromConfig` from `./helpers`.

#### Task 1-B-2: Standardize input validation in reservoir.ts
- **File:** `worker/src/cron/reserve-adapters/reservoir.ts`
- **Change:** Replace the manual `isHttpJsonInput()` check + throw with `requireJsonInputFromConfig(config, "reservoir")`.
- Import `requireJsonInputFromConfig` from `./helpers`.

#### Task 1-B-3: Forward ctx in sgforge-coinvertible.ts
- **File:** `worker/src/cron/reserve-adapters/sgforge-coinvertible.ts`
- **Change:** The `_ctx` parameter (around line 109) should be renamed to `ctx` and forwarded to the `fetchTextWithRetry` call (around line 112-116). Add `ctx` as the 4th argument: `fetchTextWithRetry(input.url, signal, 15_000, ctx)`.

#### Task 1-B-4: Use warning helper in re-metrics.ts
- **File:** `worker/src/cron/reserve-adapters/re-metrics.ts`
- **Change:** Replace the manually constructed warning object (around line 225-231) with the `reserveDegradedWarning` helper.
- The helper is already available from `./helpers`. Its signature is `reserveDegradedWarning(code: string, message: string): LiveReserveWarning` (see `warnings.ts:7`). Call: `reserveDegradedWarning("unmapped-token", \`Re Metrics token defaulted to medium risk: ${symbol}\`)`.
- This is a DRY improvement — the current code produces the correct shape but diverges from the standard factory used everywhere else.

#### Task 1-B-5: Use public-rpc-registry in anzen-usdz.ts
- **File:** `worker/src/cron/reserve-adapters/anzen-usdz.ts`
- **Change:** Replace the hardcoded `SUPPLY_CHAIN_RPC_URLS` record (around line 15-21) with lookups from the public RPC registry.
- Check how `crvusd.ts` imports and uses the registry. Mirror that pattern.
- **Important:** The registry (`worker/src/lib/public-rpc-registry.ts`) does NOT include `blast` or `manta`. Keep hardcoded URLs as fallbacks for these two chains specifically. The migration is partial by design — it centralizes the 3 chains that ARE in the registry (ethereum, base, arbitrum) while retaining hardcoded URLs for the 2 that aren't.

#### Task 1-B-6: Extract worseRisk to shared helper
- **File:** `worker/src/cron/reserve-adapters/crvusd.ts` — remove the local `RISK_SEVERITY` map and `worseRisk` function (around line 67-77).
- **File:** `worker/src/cron/reserve-adapters/slice-math.ts` — add the extracted `worseRisk(a: ReserveRisk, b: ReserveRisk): ReserveRisk` function and the `RISK_SEVERITY` map. Export both.
- Update `crvusd.ts` to import `worseRisk` from `./slice-math`.

**Verification:** Run `cd worker && npx tsc --noEmit` to confirm type safety. Run `npm test` to ensure existing adapter tests pass.

---

### Agent 1-C: Worker Core Sync Fixes

**Files:** `worker/src/cron/sync-live-reserves.ts`, `worker/src/lib/live-reserves-store-read.ts`, `scripts/check-unused-code.mjs`

#### Task 1-C-1: Fix shared-source cache failure propagation
- **File:** `worker/src/cron/sync-live-reserves.ts`
- **Location:** `tryPrimary` function (line 120-136).
- **Problem:** When a source-invariant adapter (m0, mento, sky-makercore) fails, the cached rejection is served to all subsequent coins sharing that adapter source. The `sharedSourceResults` map caches the rejected promise indefinitely within the run.
- **Fix:** Add `.catch()` cleanup on the cached promise, mirroring the pattern in `helpers.ts:getCachedRequest` (line 102-105):
```typescript
const resultPromise = runAdapterAttempt(coin, config, adapter, signal, effectiveAdapterCtx);
const cachedPromise = resultPromise.catch((error) => {
  sharedSourceResults.delete(cacheKey);
  throw error;
});
sharedSourceResults.set(cacheKey, cachedPromise);
return cachedPromise;
```
- This ensures each coin gets an independent retry opportunity if the first attempt fails.

#### Task 1-C-2: Remove dead getReserveComposition export
- **File:** `worker/src/lib/live-reserves-store-read.ts` — delete the `getReserveComposition` function at line 49-59. It is NOT imported by any production code (only referenced in `check-unused-code.mjs` allowlist and agent docs). `getReserveCompositionRow` (line 38-47, a different function) IS used by `live-reserves-store-view.ts` and must NOT be removed.
- **File:** `worker/src/lib/live-reserves-store.ts` — the barrel file uses `export * from "./live-reserves-store-read"`, so deleting the function from the source file automatically removes it from the barrel. No barrel edit needed.
- **File:** `scripts/check-unused-code.mjs` — remove the allowlist entry at line 149: `"worker/src/lib/live-reserves-store.ts::getReserveComposition"`. The dead-code script would otherwise flag a missing expected-unused export.

**Verification:** Run `cd worker && npx tsc --noEmit` and `npm test`.

---

### Agent 1-D: Frontend Fixes

**Files:** `src/components/reserve-treemap.tsx`, `src/hooks/use-stablecoin-reserves.ts`, `src/components/stablecoin-detail/overview-section.tsx`

#### Task 1-D-1: Add error boundary around Treemap
- **File:** `src/components/reserve-treemap.tsx`
- **Change:** Wrap the `<Treemap>` Recharts component in an error boundary. Use a lightweight inline error boundary class component (React's `componentDidCatch` pattern) or check if the project has an existing `ErrorBoundary` component in `src/components/`.
- The fallback should render a simple notice: "Reserve composition chart unavailable" with the reserve data as a text list fallback.
- Also: sanitize data in the existing `useMemo` — filter out slices with `pct <= 0` or non-finite `pct` before passing to Treemap.

#### Task 1-D-2: Fix fragile property spread in useStablecoinReserves
- **File:** `src/hooks/use-stablecoin-reserves.ts`
- **Change:** Replace the manual field-by-field mapping (around line 47-59) with a type-safe pattern. Do NOT use a raw `as` cast with spread — that bypasses TypeScript checking.
- **Recommended approach:** Use destructuring to separate the fields the hook does NOT need from the API response, then spread the rest:
```typescript
// Extract fields NOT in ReserveResult, spread the rest
const { stablecoinId: _id, ...reserveResult } = data;
return { reserveResult, error: null };
```
- Or: define `ReserveResult` as `Omit<StablecoinReservesResponse, 'stablecoinId'>` if that's the only difference, making the mapping type-safe by construction.
- Verify the actual shape difference between `StablecoinReservesResponse` and `ReserveResult` before choosing the pattern.

#### Task 1-D-3: Refactor reserve footnote ternary to lookup
- **File:** `src/components/stablecoin-detail/overview-section.tsx`
- **Change:** Replace the deeply nested ternary chain (around line 280-324) that switches on `reserves.mode` with a lookup object or small helper function.
- Pattern:
```typescript
const RESERVE_FOOTNOTES: Partial<Record<ReservePresentationMode, (r: ReserveResult) => ReactNode>> = {
  live: (r) => <span>Last verified ...</span>,
  "live-stale": (r) => <span className="text-amber-600">...</span>,
  "curated-fallback": () => <span>...</span>,
  "template-fallback": () => <span>...</span>,
};
```
- The `estimated` boolean (not a mode) should remain as a separate check outside the lookup.

**Verification:** Run `npm run build` to confirm the frontend compiles.

---

## Wave 2: Expand Live Reserve Coverage

### Agent 2-E: Config-Only Live Adapter Additions

**Files:** `shared/data/stablecoins/usd-minor.json`, `shared/data/stablecoins/commodity.json`

**Note:** This agent does NOT touch `usd-major.json` — the ylds-figure config was moved to Agent 1-A to avoid file overlap.

Add `liveReservesConfig` to coins that can reuse existing adapters with just a config block.

#### Task 2-E-1: ousg-ondo-finance → chainlink-nav
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `ousg-ondo-finance`
- **Template:** Copy from `usdy-ondo-finance` in `usd-major.json` (chainlink-nav adapter).
- **Changes needed:**
  - `breakerScope`: `"ousg-ondo"`
  - `display.url`: `"https://ondo.finance/ousg"`, `display.label`: `"Ondo NAV Oracle"`
  - `params.oracleAddress`: Find OUSG's NAV oracle contract on Ethereum. Check the Ondo docs or Etherscan. OUSG's token address is `0x1b19c19393e2d034d8ff31ff34c81252fcbbee92`. The oracle should be discoverable via Ondo's deployment docs or by checking read functions on the token contract.
  - `params.tokenAddress`: `"0x1b19c19393e2d034d8ff31ff34c81252fcbbee92"`
  - `params.assetLabel`: `"BlackRock BUIDL (U.S. T-bills, cash, repos)"`
  - `params.assetRisk`: `"very-low"`
  - `params.oracleMethod`: Check if OUSG uses `latestRoundData` (standard Chainlink) or `getPrice` (custom Ondo). USDY uses `getPrice`.
- **Validation:** Verify on Etherscan that the oracle contract exists and responds. If oracle is not discoverable, fall back to `curated-validated` adapter instead.

#### Task 2-E-2: nect-beraborrow → evm-branch-balances
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `nect-beraborrow`
- **Template:** Copy structure from `eusd-electronic-usd` (evm-branch-balances adapter).
- **Changes needed:**
  - `breakerScope`: `"nect-beraborrow"`
  - `inputs.primary`: `{ "kind": "onchain-evm", "chain": "berachain", "rpcMode": "public-rpc" }`
  - `params.branches`: Build from NECT's reserve composition — iBGT, iBERA/WBERA, wrapped BTC variants, ETH variants, Kodiak LP positions. Each branch needs: `name`, `holder` (CDP/vault contract address), `token.chain` ("berachain"), `token.address`, `token.decimals`, `risk`.
  - Find the NECT CDP/TroveManager contract addresses on Berachain block explorer.
- **RPC note:** Berachain is EVM-compatible but may not be in the public RPC registry. If `berachain` is not in the registry, add a `params.rpcUrl` pointing to a public Berachain RPC (e.g., `https://rpc.berachain.com`).

#### Task 2-E-3: ousd-origin-protocol → curated-validated
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `ousd-origin-protocol`
- **Adapter:** `curated-validated` — validates total supply on-chain against curated reserve slices.
- **Config:**
  - `breakerScope`: `"ousd-origin-protocol"`
  - `inputs.primary`: `{ "kind": "onchain-evm", "chain": "ethereum", "rpcMode": "public-rpc" }`
  - `display`: `{ "url": "https://analytics.ousd.com", "label": "Origin Analytics" }`

#### Task 2-E-4: reusd-resupply → curated-validated
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `reusd-resupply`
- **Adapter:** `curated-validated`.
- **Config:**
  - `breakerScope`: `"reusd-resupply"`
  - `inputs.primary`: `{ "kind": "onchain-evm", "chain": "ethereum", "rpcMode": "public-rpc" }`
  - `display`: `{ "url": "https://resupply.fi", "label": "Resupply" }`

#### Task 2-E-5: hyusd-hylo → curated-validated
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `hyusd-hylo`
- **Adapter:** `curated-validated` — Hylo operates on Solana (not EVM). No on-chain EVM supply probe possible.
- **Config:**
  - `breakerScope`: `"hyusd-hylo"`
  - `inputs.primary`: `{ "kind": "http-json", "url": "https://api.hylo.so/reserves" }` — verify API exists first. If no public JSON endpoint is discoverable, skip this coin and document why.

#### Task 2-E-6: kau-kinesis → curated-validated
- **File:** `shared/data/stablecoins/commodity.json`
- **Coin:** `kau-kinesis`
- **Adapter:** `curated-validated` — Kinesis has no on-chain contracts (centralized exchange token). Use curated-validated since `single-asset` requires either an on-chain supply probe or a JSON reserve endpoint, and Kinesis may only have PDF audit reports.
- **Config:**
  - `breakerScope`: `"kau-kinesis"`
  - Check `https://kinesis.money` for any transparency/audit JSON API endpoint. If one exists, use it as the primary input. Otherwise use a dummy HTTP-JSON input and note for manual verification.
  - `display`: `{ "url": "https://kinesis.money/audits", "label": "Kinesis Audits" }`

#### Task 2-E-7: cash-phantom → curated-validated
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `cash-phantom`
- **Adapter:** `curated-validated` — CASH is Solana-only (no EVM contracts). Prior API scan (`agents/research/2026-04-03-stablecoin-issuer-api-scan.md`) found no public API. Use curated-validated without on-chain verification.
- **Config:**
  - `breakerScope`: `"cash-phantom"`
  - `inputs.primary`: `{ "kind": "http-json", "url": "https://phantom.com/cash" }` — verify API exists first. If no public JSON endpoint, skip.
  - `display`: `{ "url": "https://phantom.com/cash", "label": "Phantom Cash" }`

**Verification:** Run `npm test` to ensure schema validation passes for all new configs. Run `cd worker && npx tsc --noEmit`.

---

### Agent 2-F: New Adapter — lisusd-lista + Type Registration for All New Adapters

**Files:** `worker/src/cron/reserve-adapters/lista.ts` (new), `worker/src/cron/reserve-adapters/index.ts`, `shared/lib/live-reserve-adapters.ts`, `shared/types/live-reserves.ts`, `shared/data/stablecoins/usd-minor.json`

**Important:** This agent handles type/registry additions for BOTH `lista` AND `abracadabra` adapter keys, since both touch the same shared files. Agent 2-H (abracadabra implementation) runs AFTER this agent and only writes its own adapter file + test.

#### Task 2-F-1: Add adapter keys to shared types (lista + abracadabra)
- **File:** `shared/types/live-reserves.ts`
- Add both `"lista"` and `"abracadabra"` to the `LIVE_RESERVE_ADAPTER_KEYS` array (which drives the `LiveReserveAdapterKey` union type).

#### Task 2-F-2: Add adapter definitions + params schemas (lista + abracadabra)
- **File:** `shared/lib/live-reserve-adapters.ts`
- Add `lista` entry to `LIVE_RESERVE_ADAPTER_DEFINITIONS`:
  - `sourceModel`: `"dynamic-mix"`
  - `evidenceClass`: `"independent"`
  - `sharedSourceMode`: `"none"`
  - `redemptionTelemetry`: `{ capacity: "none", fee: "none" }`
  - `validation`: `{ allowedFreshnessModes: ["not-applicable"] }`
- Add `abracadabra` entry to `LIVE_RESERVE_ADAPTER_DEFINITIONS`:
  - `sourceModel`: `"dynamic-mix"`
  - `evidenceClass`: `"independent"`
  - `sharedSourceMode`: `"none"`
  - `redemptionTelemetry`: `{ capacity: "none", fee: "none" }`
  - `validation`: `{ maxUnknownExposurePct: 5, allowedFreshnessModes: ["not-applicable"] }`
- **Critical:** Also add entries to the `adapterParamsSchemas` object (around line 217). This object is typed as `satisfies Record<LiveReserveAdapterKey, z.ZodTypeAny>` — adding a key to `LIVE_RESERVE_ADAPTER_KEYS` without a matching schema entry causes a TypeScript compilation error.
  - For `lista`: Use `evmBranchBalancesParamsSchema` if the adapter reuses the same params shape, or define a custom Zod schema.
  - For `abracadabra`: Define a custom Zod schema for cauldron addresses and collateral token metadata.

#### Task 2-F-3: Implement lista adapter
- **File:** `worker/src/cron/reserve-adapters/lista.ts` (new)
- **Pattern:** Follow `evm-branch-balances.ts` as template. ListaDAO's lisUSD is an over-collateralized CDP stablecoin on BNB Chain.
- Key collateral types from curated data: BNB, slisBNB, wBETH, ETH-LSTs on BSC.
- Read collateral balances from ListaDAO's vault/join contracts on BSC.
- **Research reference:** `agents/research/2026-03-14-crypto-backed-reserve-sources.md` — section "lisUSD (Lista DAO)" has contract details, collateral types, and architecture notes.
- **RPC note:** BSC IS in the public RPC registry (`worker/src/lib/public-rpc-registry.ts`). Use `getPublicRpcUrl("bsc")` rather than hardcoding a BSC RPC URL.
- Export both `adaptListaReserves` (pure transform) and `fetchListaReserves` (I/O entrypoint).

#### Task 2-F-4: Register both adapters in index.ts
- **File:** `worker/src/cron/reserve-adapters/index.ts`
- Import `fetchListaReserves` from `./lista` and add to `ADAPTER_FNS` map.
- **For abracadabra:** TypeScript will not compile with an import from a non-existent module. Agent 2-F MUST create a minimal stub file `abracadabra.ts` that exports the function signature with a `throw new Error("not implemented")` body:
```typescript
import type { AdapterFn } from "./types";
export const fetchAbracadabraReserves: AdapterFn = () => {
  throw new Error("abracadabra adapter not yet implemented");
};
```
- Import `fetchAbracadabraReserves` from `./abracadabra` and add to `ADAPTER_FNS` map.
- Agent 2-H will replace the stub with the full implementation.

#### Task 2-F-5: Add liveReservesConfig to lisUSD
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `lisusd-lista`
- Add `liveReservesConfig` with adapter `"lista"`, semantics `"collateral-mix"`, BSC on-chain input.

#### Task 2-F-6: Add adapter test
- Create test file `worker/src/cron/reserve-adapters/__tests__/lista.test.ts`.
- Test the `adaptListaReserves` pure function with a mocked response fixture.

**Verification:** `cd worker && npx tsc --noEmit`, `npm test`.

---

### Agent 2-H: New Adapter — mim-abracadabra (implementation only)

**Files:** `worker/src/cron/reserve-adapters/abracadabra.ts` (new or replace stub from 2-F), `shared/data/stablecoins/usd-minor.json`

**Runs AFTER Agent 2-F completes.** The adapter key, definition, params schema, and index.ts registration are already done by Agent 2-F. This agent only writes the implementation file, the liveReservesConfig, and the test.

#### Task 2-H-1: Implement abracadabra adapter
- **File:** `worker/src/cron/reserve-adapters/abracadabra.ts` (replace stub if exists, or create new)
- MIM uses multi-cauldron architecture. Each cauldron holds a single collateral type.
- Pattern: Read `totalCollateralShare` from each cauldron contract on Ethereum/Arbitrum, convert to USD via DefiLlama prices.
- Similar to `crvusd.ts` in structure (iterating over markets, reading on-chain balances).
- **Research reference:** `agents/research/2026-03-14-crypto-backed-reserve-sources.md` — section "MIM (Abracadabra)" has contract addresses, ABI details, and MIM Treasury address `0xDF2C270f610Dc35d8fFDA5B453E74db5471E126B`.
- Export `adaptAbracadabraReserves` (pure) and `fetchAbracadabraReserves` (I/O).

#### Task 2-H-2: Add liveReservesConfig to mim-abracadabra
- **File:** `shared/data/stablecoins/usd-minor.json`
- **Coin:** `mim-abracadabra`
- Configure with Ethereum on-chain input, cauldron addresses in params.

#### Task 2-H-3: Add adapter test
- Test `adaptAbracadabraReserves` with mocked multi-cauldron data.

**Verification:** `cd worker && npx tsc --noEmit`, `npm test`.

---

## Wave 3: Complex Adapter Upgrade

### Agent 3-I: Tether Adapter Upgrade

**Files:** `worker/src/cron/reserve-adapters/tether.ts`, `shared/data/stablecoins/usd-major.json` (for static reserves update)

#### Task 3-I-1: Research current Tether transparency data
- The current adapter (`tether.ts`) returns a single `100%` slice labeled "Issuer-attested reserves (coarse composition undisclosed in this feed)" because the JSON API only returns total_assets / total_liabilities / shareholder_eq.
- Investigate whether Tether's transparency page (`https://tether.to/en/transparency/`) now exposes category-level breakdown data in a machine-readable format (JSON, structured HTML attributes, or API).
- Check the quarterly attestation reports for the latest breakdown percentages.

#### Task 3-I-2: Implement composition parsing (if data available)
- If Tether now publishes category data (U.S. Treasury Bills, cash, secured loans, etc.) via API or structured HTML:
  - Add an HTML scraping input as fallback or replace the JSON input.
  - Parse the breakdown into `ReserveSlice[]` with appropriate risk tags from the canonical map.
  - Keep the existing single-bucket path as a fallback if parsing fails.
- If no machine-readable breakdown is available (most likely outcome):
  - Use the latest quarterly attestation percentages as a `curated-validated` static overlay.
  - Update `usdt-tether`'s static `reserves` field in `usd-major.json` with accurate percentages from the most recent attestation (currently the reserves field likely has generic data).
  - Switch the adapter from `tether` to `curated-validated` which validates supply on-chain.

#### Task 3-I-3: Update adapter definition if needed
- If the adapter now returns a composition mix, update `LIVE_RESERVE_ADAPTER_DEFINITIONS.tether`:
  - `sourceModel`: `"dynamic-mix"` (up from `"single-bucket"`)
  - `evidenceClass`: Keep `"weak-live-probe"` unless the new source is independently verifiable.

#### Task 3-I-4: Add/update tests
- Update `tether.test.ts` with fixtures for the new response format.
- Test fallback to single-bucket if the new format fails.

**Verification:** `cd worker && npx tsc --noEmit`, `npm test`.

---

## Wave 4: Verification

### Agent 4-J: Integration Tests

**Files:** `worker/src/cron/__tests__/` (new test files)

#### Task 4-J-1: End-to-end sync → API integration test
- **File:** `worker/src/cron/__tests__/reserve-sync-integration.test.ts` (new)
- Test the complete flow: adapter fetch (mocked) → validation → D1 write → API resolution.
- Use the existing `mockD1()` test helper.
- Scenarios:
  1. Happy path: adapter returns valid slices → stored in D1 → API returns mode: "live"
  2. Adapter failure: adapter throws → sync_state records error → API falls back to curated
  3. Stale data: composition older than threshold → API returns mode: "live-stale"
  4. Validation rejection: adapter returns invalid output (pct sum = 110) → rejected → API falls back

#### Task 4-J-2: Adapter registry completeness test
- **File:** `worker/src/cron/reserve-adapters/__tests__/registry.test.ts` (new)
- Test that every key in `LIVE_RESERVE_ADAPTER_KEYS` has:
  1. A matching entry in the `ADAPTER_FNS` map (import from `../index`)
  2. A matching entry in `LIVE_RESERVE_ADAPTER_DEFINITIONS` (import from `@shared/lib/live-reserve-adapters`)
- Note: `adapterParamsSchemas` is module-private in `live-reserve-adapters.ts` and cannot be tested directly. Instead, test that `parseLiveReserveAdapterParams(key, {})` does not throw "unknown adapter" for each key — this validates the params schema entry exists.

### Agent 4-K: Merge Gate

#### Task 4-K-1: Run merge gate
- Run `npm run test:merge-gate` and confirm clean pass.
- If any failures, diagnose and fix.

**Verification:** Clean merge gate is the final signal.

---

## Dependency Graph

```
Wave 1 (all 4 parallel, disjoint files):
  Agent 1-A (data + ylds config)  ─┐
  Agent 1-B (adapter fixes)        ├──► Wave 2:
  Agent 1-C (core sync fixes)     ─┤     Agent 2-E (config-only)        ─── runs in parallel with 2-F ──┐
  Agent 1-D (frontend fixes)      ─┘     Agent 2-F (lista + type reg)   ─── runs in parallel with 2-E ──┤
                                                     │                                                    │
                                                     ▼ (2-H depends ONLY on 2-F, not 2-E)               │
                                          Agent 2-H (abracadabra impl)  ─────────────────────────────────┘
                                                     │
                                                     ▼
                                          Wave 3: Agent 3-I (tether upgrade)
                                                     │
                                                     ▼
                                          Wave 4: Agent 4-J (tests) → Agent 4-K (gate)
```

## Risk Notes

- **Wave 2 shared file conflict is resolved.** Agent 2-F handles ALL type/registry additions for both lista and abracadabra. Agent 2-H runs after 2-F and only writes its implementation file + test + JSON config. No merge conflicts.
- **Config-only additions (2-E)** depend on verifying oracle/API endpoints exist. If an endpoint is not discoverable, the agent should fall back to `curated-validated` or skip the coin and document why.
- **Tether upgrade (3-I)** may conclude that no improvement is possible if Tether still doesn't publish machine-readable breakdowns. The fallback is updating the static reserves with current attestation data and switching to `curated-validated`. Note: this agent also edits `usd-major.json`, which was already modified by Agent 1-A in Wave 1. Since Wave 3 runs strictly after Wave 1, there is no parallelism conflict — but the implementing agent must work against the current file state (post-Wave-1), not against a stale baseline.
- **Non-EVM coins (hyusd, ylds, cash, kau)** can only get `curated-validated` configs (no on-chain supply verification). This is still an improvement over having no `liveReservesConfig` at all — they move from "unavailable" to "curated-validated" presentation mode.
- **Berachain RPC (nect):** If `berachain` is not in the public RPC registry, the config must include a `params.rpcUrl` fallback pointing to a public Berachain RPC endpoint.
