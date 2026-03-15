# Yield Intelligence Remediation & Expansion

**Date:** 2026-03-15
**Scope:** Remediate all code quality issues and execute all Priority 1 + Priority 2 improvement opportunities from the yield intelligence audit.
**Approach:** Single branch, phased commits.

---

## Context

The yield intelligence audit (`agents/audits/yield-intelligence-audit-2026-03-15.md`) identified 4 code quality issues, 4 Priority 1 quick wins, and 4 Priority 2 medium-effort improvements. This spec covers all P1 items, P2-2a (lending allowlist expansion), P2-2b (test coverage extension), and P2-2c (auto-discovery match audit).

**Out of scope (deferred to separate projects):**
- Staking/restaking yield source type (new data model)
- Multi-chain yield view (new UI surface)
- CEX lending rate integration (requires new API credentials)
- Two-tier safety gate (requires UI changes for risk labeling)
- B.Protocol LUSD generic reward estimator extraction (P2-2d): The B.Protocol LUSD source is a unique protocol-specific calculation with bespoke on-chain reads (Stability Pool deposits + LQTY issuance). There are no other similar reward estimators to generalize to today. Extracting it into a config-driven registry adds abstraction without a second consumer. Defer until a second protocol needs the same pattern.

---

## Phase 1: Code Quality Fixes

### 1a. Remove duplicate TRACKED_META_BY_ID

**File:** `worker/src/cron/yield-sync/resolve.ts:33`
**Issue:** Builds a local `new Map(TRACKED_STABLECOINS.map(...))` identical to the one already exported from `@shared/lib/stablecoins`.
**Fix:** Replace lines 1, 33-35 with an import of `TRACKED_META_BY_ID` from `@shared/lib/stablecoins`. Remove the now-unused `TRACKED_STABLECOINS` import if no other usage remains in the file.

### 1b. Fix stale YIELD_POOL_MAP gate comment

**File:** `worker/src/cron/yield-config.ts:181`
**Issue:** Comment says "21/24 coins matched" but the map now has 33 entries.
**Fix:** Update to reflect the actual entry count. Make the comment generic enough to not go stale again (e.g., "see map entries below" rather than a hardcoded count).

### 1c. Extract LEGACY_MAX_AGE_SEC magic number

**File:** `worker/src/cron/sync-yield-data.ts:311`
**Issue:** `35 * 86400` is a magic number with only an inline comment.
**Fix:** Move to module-level named constant alongside `MAX_RETAINED_RISK_FREE_RATE_AGE_SEC` and friends. Compose from existing `SECONDS` constants (e.g., `SECONDS.THIRTY_DAYS + 5 * SECONDS.ONE_DAY`) or define as `35 * 86_400` with a clear name like `LEGACY_HISTORY_MAX_AGE_SEC`.

### 1d. Document Layer 3 .includes() asymmetry and add length guard

**File:** `worker/src/cron/yield-helpers.ts:154-162`
**Issue:** Layer 3 uses `.includes()` while Layer 2 uses `===`. The intentional asymmetry is undocumented and risks false positives for short symbols.
**Fix:**
1. Add a block comment explaining: Layer 3 is intentionally looser to catch DL pools with prefixed/suffixed symbols (e.g., "FEUSDH" for USDH). Layers 1/2 catch most coins first, so Layer 3 only fires when both miss.
2. Add a minimum symbol length guard: skip `.includes()` matching for symbols shorter than 4 characters to prevent "USD" from matching everything.

---

## Phase 2: On-Chain Rate Expansion (Tier 1)

### Goal

Expand `ON_CHAIN_RATE_CONFIGS` from 4 to ~16 entries by adding ERC-4626 vault configs for yield-bearing stablecoins that currently rely on DeFiLlama for their APY.

### Process per coin

1. Look up the staking/savings vault contract address on Etherscan (or relevant chain explorer)
2. Verify the contract implements `convertToAssets(uint256)` (standard ERC-4626)
3. Verify the token decimals
4. Add `variantAddress` to `YIELD_VARIANT_MAP` if missing
5. Add entry to `ON_CHAIN_RATE_CONFIGS`

### Candidates

| Coin ID | Wrapper | Chain | Decimals | Notes |
|---------|---------|-------|----------|-------|
| `reusd-re-protocol` | stUSR | Ethereum | 18 | Address already in variant map |
| `usds-sky` | sUSDS | Ethereum | 18 | Needs address lookup |
| `dai-makerdao` | sDAI | Ethereum | 18 | Needs address lookup |
| `crvusd-curve` | scrvUSD | Ethereum | 18 | Needs address lookup |
| `frxusd-frax` | sfrxUSD | Ethereum | 18 | Needs address lookup |
| `dola-inverse-finance` | sDOLA | Ethereum | 18 | Needs address lookup |
| `bold-liquity` | yBOLD | Ethereum | 18 | Needs address lookup |
| `usdf-falcon` | sUSDf | Ethereum | 18 | Needs address lookup |
| `avusd-avant` | savUSD | Ethereum | 18 | Needs address lookup |
| `nusd-neutrl` | sNUSD | Ethereum | 18 | Needs address lookup |
| `usdai-usd-ai` | sUSDai | Ethereum/Arbitrum | 18 | Needs address lookup; check which chain |
| `usn-noon` | sUSN | Ethereum | 18 | Needs address lookup |
| `yzusd-yuzu` | syzUSD | Ethereum/Plasma | 18 | Needs address lookup; check if ERC-4626 |
| `msusd-main-street` | msY | Ethereum | 18 | Needs address lookup; may not be ERC-4626 |
| `aid-gaib` | sAID | Ethereum | 18 | Needs address lookup |

### Exclusions (not ERC-4626 or not EVM)

- `gho-aave` (sGHO): Custom staking module, not ERC-4626. Keep DL pool as primary.
- `usdu-unitas` (sUSDu): Solana program, not EVM. Keep DL pool.
- `aznd-mu-digital` (loAZND): Monad chain, no RPC support in worker yet. Keep DL pool.
- `fxusd-f-x-protocol` (fxSAVE): Needs verification; may be custom interface.
- `usdp-parallel` (sUSDp): Already in ON_CHAIN_RATE_CONFIGS.

### Connection budget

Each `eth_call` is lightweight (~200 bytes request, ~32 bytes response). Current: 4 calls. Projected: ~16 calls. All to Ethereum RPCs (one endpoint), executed sequentially within the existing `fetchOnChainRates()` loop. Well within the 6-connection trigger budget since these are serial, not concurrent.

---

## Phase 3: Rate-Derived Expansion

### Addition

Add OUSG to `RATE_DERIVED_CONFIGS`:

```typescript
{ stablecoinId: "ousg-ondo-finance", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" }
```

OUSG is an Ondo US Government Bond fund that mechanically tracks short-term rates minus management fee. It's currently served by its DL pool (Tier 2), but a rate-derived entry (Tier 4) provides a deterministic baseline. The confidence-weighted arbitration system will use the DL pool when available (higher confidence) and fall back to rate-derived when DL is stale.

---

## Phase 4: Lending Protocol Allowlist Expansion

### New protocols

| Protocol | DL Slug | Rationale |
|----------|---------|-----------|
| Radiant v2 | `radiant-v2` | Multi-chain lending (ARB/BSC), USDC/USDT markets |
| Fraxlend v2 | `fraxlend-v2` | Frax ecosystem, FRAX pair lending |
| Clearpool | `clearpool` | Institutional credit, USDC |
| Centrifuge | `centrifuge` | RWA lending, various stablecoins |
| Sturdy v2 | `sturdy-v2` | Yield aggregator, various stablecoins |
| Goldfinch | `goldfinch` | Real-world credit, USDC |
| TrueFi | `truefi` | Institutional credit, USDC |

Each addition requires:
1. Entry in `LENDING_PROTOCOL_ALLOWLIST`
2. Entry in `LENDING_PROTOCOL_LABELS`

No code changes needed beyond config — the auto-discovery engine already processes any allowlisted protocol.

### Expected impact

+5-15 additional lending opportunity matches for coins that currently have no yield data.

---

## Phase 5: Auto-Discovery Match Rate Improvement

### Approach

Manually cross-reference DeFiLlama pool data against tracked stablecoin contract addresses to find pools that would match by address but miss due to symbol drift. This is a one-time research task, not a permanent script.

### Method

1. Fetch the full DeFiLlama pools dataset from `https://yields.llama.fi/pools` (the raw API, not the processed `/api/yield-rankings` endpoint which lacks `underlyingTokens` data)
2. For each tracked stablecoin, check if any DL pool's `underlyingTokens` array contains one of the coin's known contract addresses
3. Where a match is found but symbol doesn't match: add to `AUTO_LENDING_POOL_MAP`

### Expected output

5-10 new `AUTO_LENDING_POOL_MAP` entries for coins with symbol drift.

---

## Phase 6: Test Coverage

### 6a. Extend integration tests for syncYieldData()

**File:** `worker/src/cron/__tests__/sync-yield-data.test.ts` (exists, 1175 lines, 19 test cases)

**Already covered:** Happy path, stale/orphan cleanup, D1 chunking, cached DL pools, deterministic auto-discovery override, B.Protocol LUSD, DL API failure, circuit breaker open, schema validation, price-derived fallback, source-specific history, legacy history carry-forward, rate-derived, degraded safety coverage.

**Gaps to fill (add new test cases):**
- On-chain rate expansion: verify new Tier 1 configs produce valid APY entries (at least one new vault)
- OUSG rate-derived: verify the new OUSG rate-derived config participates in arbitration

### 6b. Extend resolve/arbitration tests

**File:** `worker/src/cron/__tests__/yield-resolve.test.ts` (exists, 1010 lines, 13 test cases)

**Already covered:** DL curated source selection, deterministic rate-derived preference, cross-source divergence rejection (>35%), T-bill excess yield computation, negative excess yield, hardcoded fallback rate, rate-derived from T-bill, rate floor at zero, yield-spike warning, TVL-outflow warning, stable conditions, PYS computation, PYS=0 for zero APY.

**Gaps to fill:**
- Price-derived as explicit source (Tier 3 path through resolve, not just navToken fallback)
- Auto-discovery path (non-yield-bearing coin matches a lending pool)

### 6c. New cache parsing tests

**File:** `worker/src/cron/__tests__/yield-cache.test.ts` (new)

Test `parseDlStablecoinPoolsCache` and `parseRiskFreeRateCache`:
- Valid JSON → correct parse
- Malformed JSON → null
- Legacy format → correct migration
- Missing fields → graceful degradation

### 6d. Extend yield-source-links tests

**File:** `worker/src/lib/__tests__/yield-source-links.test.ts` (exists, 44 lines, 4 test cases)

**Already covered:** Curated protocol link for discovered source, source-specific override, metadata app link fallback, website fallback.

**Gaps to fill:**
- No-match case: returns null when no curated link, no protocol match, and no metadata link
- New lending protocols: verify at least one of the newly added protocols resolves a URL

---

## Phase 7: Documentation Updates

### Files to update

1. **`docs/yield-intelligence.md`:**
   - Update Tier 1 on-chain rate count (4 → ~16)
   - Update lending protocol allowlist count (28 → 35)
   - Update `AUTO_LENDING_POOL_MAP` entries count
   - Update `YIELD_POOL_MAP` entry count
   - Add new rate-derived entry (OUSG)
   - Update test coverage section

2. **`docs/worker-and-api-limits.md`:**
   - No changes needed (no new timing constraints or connection patterns)

3. **`docs/coverage-page.md`:**
   - Update if new protocols change the coverage matrix

4. **`docs/about-page.md`:**
   - No changes needed (no new external data sources)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Wrong vault address for on-chain config | Low | Medium (wrong APY) | Verify each address on Etherscan; test with live `eth_call` |
| Non-ERC-4626 vault in ON_CHAIN_RATE_CONFIGS | Low | Low (graceful failure) | `fetchOnChainRates` already handles failed calls; coin falls back to DL pool |
| New lending protocol returns spam pools | Low | Low (quality gates) | Existing TVL ($1M) and APY (0.5%) thresholds filter noise |
| Connection budget exceeded | Very Low | Medium (cron timeout) | All new `eth_call`s are serial to same RPC; lightweight calls |
| Test mocks drift from real D1 behavior | Medium | Low | Mock at interface boundary; test observable behavior |

---

## Success Criteria

1. All 4 code quality issues resolved
2. Tier 1 on-chain rate coverage expanded from 4 to 12+ coins
3. Lending protocol allowlist expanded from 28 to 35 protocols
4. OUSG added as rate-derived source
5. AUTO_LENDING_POOL_MAP populated with symbol-drift matches
6. Integration test for syncYieldData() passes
7. Unit tests for resolve, cache, and source-links pass
8. All existing tests still pass
9. Build and type-check pass
10. Documentation updated to reflect changes
