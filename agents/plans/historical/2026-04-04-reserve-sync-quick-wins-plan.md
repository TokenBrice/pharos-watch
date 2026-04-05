# Reserve Sync Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live reserve sync to 3 stablecoins that can reuse existing adapters — zero new adapter code, config-only changes.

**Architecture:** Each coin gets a `liveReservesConfig` entry in its JSON data file, pointing to an existing adapter. USDSC reuses the `m0` adapter (same M0 Protocol treasury backing as M/USDN/CTUSD/MUSD). USDai reuses `usdai-proof-of-reserves` (same reserve pool as sUSDai). satUSD uses `curated-validated` with an on-chain EVM supply probe against its Ethereum contract.

**Tech Stack:** TypeScript strict, Vitest, shared/data stablecoin JSON files.

**Verification:** `npm run test:merge-gate` must pass after all changes.

---

### Task 1: Add USDSC (Startale) live reserves via m0 adapter

USDSC is a wrapper around M (M0 Protocol). The existing `m0` adapter fetches from `protocol-api.m0.org/graphql` with `source-invariant` caching — all M0 extensions share one fetch per cron cycle. Four coins already use this adapter (m-m0, musd-metamask, usdn-noble, ctusd-citrea).

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (the `usdsc-startale` entry)

- [ ] **Step 1: Add liveReservesConfig to USDSC**

In `shared/data/stablecoins/usd-minor.json`, find the `usdsc-startale` entry. Add this `liveReservesConfig` block after the `"reserves"` field (same level as `"reserves"`, `"contracts"`, etc.):

```json
"liveReservesConfig": {
  "adapter": "m0",
  "version": 1,
  "semantics": "protocol-reserve",
  "breakerScope": "m0",
  "display": {
    "url": "https://dashboard.m0.org/",
    "label": "M0 Dashboard"
  },
  "inputs": {
    "primary": {
      "kind": "http-json",
      "url": "https://protocol-api.m0.org/graphql"
    }
  }
}
```

This is identical to the config used by `m-m0`, `musd-metamask`, `usdn-noble`, and `ctusd-citrea`. The `breakerScope: "m0"` is required because the adapter is reused across 5+ coins (test in `stablecoins.test.ts` enforces this). The `source-invariant` shared source mode means only one GraphQL request is made per cron cycle.

- [ ] **Step 2: Run the stablecoin schema validation tests**

Run: `npx vitest run shared/lib/__tests__/stablecoins.test.ts`

Expected: PASS — the schema validator accepts the new config, breaker scope is set for the reused adapter, and all existing constraints hold.

- [ ] **Step 3: Run the m0 adapter unit tests**

Run: `npx vitest run worker/src/cron/reserve-adapters/__tests__/m0.test.ts`

Expected: PASS — no adapter code changed, just config.

- [ ] **Step 4: Commit**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "enable live reserves for USDSC (Startale) via m0 adapter"
```

---

### Task 2: Add USDai (USD.AI) live reserves via curated-validated adapter

USDai is the base (non-yielding) USD.AI token, backed 100% by PYUSD. The GPU infrastructure deal exposure is exclusively on sUSDai (the staked yield-bearing version). For USDai, we use `curated-validated` with an on-chain EVM supply probe against its Ethereum contract (`0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef`, 18 decimals). This validates the token is live and returns the static `reserves: [{PYUSD: 100%}]`.

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json` (the `usdai-usd-ai` entry)

- [ ] **Step 1: Add liveReservesConfig to USDai**

In `shared/data/stablecoins/usd-major.json`, find the `usdai-usd-ai` entry. Add this `liveReservesConfig` block at the same level as `"reserves"`:

```json
"liveReservesConfig": {
  "adapter": "curated-validated",
  "version": 1,
  "semantics": "single-asset",
  "breakerScope": "usdai-usd-ai",
  "display": {
    "url": "https://app.usd.ai/reserves",
    "label": "USD.AI Reserves"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "public-rpc"
    }
  }
}
```

The `curated-validated` adapter probes on-chain totalSupply via the coin's Ethereum contract (found via `contracts[]`). If non-zero, it returns the curated reserves: `[{"name": "PYUSD (PayPal USD)", "pct": 100, "risk": "low", "coinId": "pyusd-paypal"}]`. This correctly reflects that USDai is 100% PYUSD-backed — unlike sUSDai which carries the GPU deal exposure.

`breakerScope: "usdai-usd-ai"` is required because `curated-validated` is reused across 20+ coins.

- [ ] **Step 2: Run the stablecoin schema validation tests**

Run: `npx vitest run shared/lib/__tests__/stablecoins.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the curated-validated adapter unit tests**

Run: `npx vitest run worker/src/cron/reserve-adapters/__tests__/curated-validated.test.ts`

Expected: PASS — no adapter code changed, just config.

- [ ] **Step 4: Commit**

```bash
git add shared/data/stablecoins/usd-major.json
git commit -m "enable live reserves for USDai via curated-validated adapter"
```

---

### Task 3: Add satUSD (River) live reserves via curated-validated adapter

satUSD is a Liquity v1-style CDP backed by BTC, ETH, BNB, and LSTs. It already has a curated `reserves` array defining 4 slices. The `curated-validated` adapter probes on-chain totalSupply to confirm the token is live, then returns the curated reserves as live slices. satUSD has an Ethereum contract (`0x1958853a8be062dc4f401750eb233f5850f0d0d2`, 18 decimals).

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (the `satusd-river` entry)

- [ ] **Step 1: Add liveReservesConfig to satUSD**

In `shared/data/stablecoins/usd-minor.json`, find the `satusd-river` entry. Add this `liveReservesConfig` block at the same level as `"reserves"`:

```json
"liveReservesConfig": {
  "adapter": "curated-validated",
  "version": 1,
  "semantics": "collateral-mix",
  "breakerScope": "satusd-river",
  "display": {
    "url": "https://river.inc/",
    "label": "River Dashboard"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "public-rpc"
    }
  }
}
```

The `onchain-evm` primary input tells the adapter to probe the Ethereum chain. The adapter looks up the coin's Ethereum contract address from `contracts[]` (`0x1958853a8be062dc4f401750eb233f5850f0d0d2`) and calls `totalSupply()`. If non-zero, it returns the curated reserves:
- BTC (overcollateralized CDP) — 40% — medium
- ETH (overcollateralized CDP) — 30% — medium
- BNB (overcollateralized CDP) — 15% — medium
- Liquid staking tokens — 15% — medium

`breakerScope` is `"satusd-river"` — unique, since `curated-validated` is reused across 20+ coins and the test requires explicit scopes for reused adapters.

- [ ] **Step 2: Run the stablecoin schema validation tests**

Run: `npx vitest run shared/lib/__tests__/stablecoins.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the curated-validated adapter unit tests**

Run: `npx vitest run worker/src/cron/reserve-adapters/__tests__/curated-validated.test.ts`

Expected: PASS — no adapter code changed.

- [ ] **Step 4: Commit**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "enable live reserves for satUSD (River) via curated-validated adapter"
```

---

### Task 4: Run the full merge gate

- [ ] **Step 1: Run merge gate**

Run: `npm run test:merge-gate`

Expected: PASS — all lint, type-checks, and tests pass including the new configs.

- [ ] **Step 2: Verify reserve adapter count increased**

Run a quick count to confirm we went from 120 → 123 live-reserve coins:

```bash
node -e "
const all = [
  ...require('./shared/data/stablecoins/usd-major.json'),
  ...require('./shared/data/stablecoins/usd-minor.json'),
  ...require('./shared/data/stablecoins/non-usd.json'),
  ...require('./shared/data/stablecoins/commodity.json'),
];
const live = all.filter(c => c.liveReservesConfig);
console.log('Live reserve sync:', live.length, '/', all.length, 'total');
const newCoins = ['usdsc-startale', 'usdai-usd-ai', 'satusd-river'];
for (const id of newCoins) {
  const coin = live.find(c => c.id === id);
  console.log(id, coin ? '✓ ' + coin.liveReservesConfig.adapter : '✗ MISSING');
}
"
```

Expected output:
```
Live reserve sync: 123 / 187 total
usdsc-startale ✓ m0
usdai-usd-ai ✓ usdai-proof-of-reserves
satusd-river ✓ curated-validated
```

- [ ] **Step 3: Final commit (if any fixups were needed)**

---

## Out of Scope: OUSD (Origin Dollar)

The research identified `api.originprotocol.com/api/v2/ousd/collateral` as a potential live reserve source. **This endpoint currently returns 404.** The OETH collateral endpoint (`/api/v2/oeth/collateral`) works and returns `[{name, total, price, value}]` JSON, but the equivalent OUSD endpoint does not.

Working OUSD endpoints: `/api/v2/ousd/stats/totalSupply` (returns `"7635326.20..."`) and `/api/v2/ousd/ratios`. These give supply data but not collateral composition.

**To revisit:** When the OUSD collateral endpoint is restored, a new `origin-protocol` adapter (or reuse of `accountable`-style pattern) could parse the `[{name, total, price, value}]` response into reserve slices. OUSD's static reserves are: USDC via Morpho/Yearn (65%) + USDC via Curve AMO (35%).
