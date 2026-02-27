# Reserve Composition: Manual Curation (Tier A) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Manually research and add accurate `reserves` data for the top ~20 stablecoins by market cap, using attestation reports and official transparency pages as primary sources.

**Architecture:** For each coin, research its official attestation/transparency report, extract the reserve breakdown, classify each slice by risk tier, and add the `reserves` array to the coin's entry in `src/lib/stablecoins.ts`. No new types, components, or infrastructure needed — the `ReserveSlice[]` type and `ReserveTreemap` component already exist and work.

**Tech Stack:** Web research (WebSearch, WebFetch, agent-browser), manual data entry into TypeScript.

---

## Context

### Current State
- 143 tracked stablecoins, only 5 have `reserves` data (USDT, USDC, USDe, USDS, DAI)
- Reserve data lives in `src/lib/stablecoins.ts` as `reserves: ReserveSlice[]` on each `StablecoinMeta`
- The `ReserveTreemap` component at `src/components/reserve-treemap.tsx` renders automatically when `coin.reserves` exists

### Data Structure
```typescript
// src/lib/types.ts:72-77
type ReserveRisk = "low" | "medium" | "high";
interface ReserveSlice {
  name: string;      // e.g. "U.S. Treasury Bills"
  pct: number;       // percentage of total reserves (should sum to ~100)
  risk: ReserveRisk; // low=green, medium=amber, high=red
}
```

### Risk Classification Guide
| Risk | Description | Examples |
|------|-------------|---------|
| `low` | Cash, T-bills, repos, FDIC-insured deposits, regulated money market funds | U.S. Treasuries, overnight repos, Circle Reserve Fund |
| `medium` | Blue-chip crypto (ETH, BTC), institutional-grade RWA, regulated stablecoins as collateral | wstETH, WBTC, corporate bonds, USDC backing |
| `high` | Volatile/exotic crypto, unsecured loans, algorithmic positions, altcoins | SOL, altcoin collateral, perpetual futures, other vaults |

### Target Coins (15 without reserves, ranked by market cap)

These are the next-largest coins after the 5 already done:

| # | Symbol | ID | Backing | Governance | Has `proofOfReserves`? |
|---|--------|----|---------|------------|----------------------|
| 1 | USD1 | 262 | rwa-backed | centralized | Yes (BitGo) |
| 2 | PYUSD | 120 | rwa-backed | centralized | Yes (KPMG) |
| 3 | USDf | 246 | crypto-backed | centralized-dependent | Yes (ht.digital) |
| 4 | USYC | 237 | rwa-backed | centralized | No |
| 5 | USDG | 286 | rwa-backed | centralized | No |
| 6 | RLUSD | 250 | rwa-backed | centralized | Yes (BPM LLP) |
| 7 | USDY | 129 | rwa-backed | centralized | Yes (NAV Consulting) |
| 8 | BUIDL | 173 | rwa-backed | centralized | No |
| 9 | USDD | 14 | crypto-backed | centralized-dependent | Yes (real-time) |
| 10 | USDTB | 221 | rwa-backed | centralized | No |
| 11 | M | 213 | rwa-backed | centralized | Yes (Chainlink) |
| 12 | GHO | 118 | crypto-backed | centralized-dependent | No |
| 13 | FDUSD | 119 | rwa-backed | centralized | Yes (Prescient) |
| 14 | TUSD | 7 | rwa-backed | centralized | Yes (Moore HK) |
| 15 | FRAX | 6 | rwa-backed | centralized-dependent | No |

---

### Task 1: USD1 (World Liberty Financial)

**Files:**
- Modify: `src/lib/stablecoins.ts:171-185` (USD1 entry)

**Step 1: Research reserve composition**

Search for: "World Liberty Financial USD1 reserves attestation BitGo" and visit the proof-of-reserves URL already in the codebase: `https://www.bitgo.com/usd1/attestations/`

Extract the reserve breakdown from the latest attestation. The `collateral` field already says: "Short-term U.S. government Treasury bills, U.S. dollar deposits, and other cash equivalents held by BitGo Trust Company"

Expected structure (verify against actual attestation):
```typescript
reserves: [
  { name: "U.S. Treasury Bills", pct: ??, risk: "low" },
  { name: "Cash Deposits", pct: ??, risk: "low" },
  { name: "Cash Equivalents", pct: ??, risk: "low" },
],
```

**Step 2: Add reserves array**

Edit `src/lib/stablecoins.ts`, add `reserves` to the USD1 entry (before the closing `}`/`)` at line ~185):
```typescript
    reserves: [
      // fill with researched percentages
    ],
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds, no type errors.

**Step 4: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(reserves): add USD1 reserve composition from BitGo attestation"
```

---

### Tasks 2–15: Repeat for each remaining coin

Follow the exact same 4-step pattern for each coin:

1. **Research**: Visit the `proofOfReserves.url` if it exists, otherwise web-search for `"<coin name> reserves breakdown attestation <year>"`. Use `agent-browser` if WebFetch returns 403.
2. **Add reserves array**: Edit the coin's entry in `src/lib/stablecoins.ts`
3. **Build check**: `npm run build`
4. **Commit**: One commit per coin (or batch 2-3 similar coins per commit)

#### Research hints per coin:

| Coin | Primary Source | Notes |
|------|---------------|-------|
| **PYUSD** | `https://www.paxos.com/pyusd-transparency` | Paxos publishes monthly attestation PDFs (KPMG) |
| **USDf** | `https://app.falcon.finance/transparency` | Real-time dashboard; delta-neutral like USDe |
| **USYC** | Hashnote docs / SEC filings | T-bill fund, likely 100% low-risk |
| **USDG** | Paxos transparency page | Same issuer as PYUSD, DBS/StanChart custody |
| **RLUSD** | `https://www.ripple.com/rlusd` | BPM LLP attestation |
| **USDY** | `https://ondo.finance/transparency` | NAV Consulting monthly reports |
| **BUIDL** | BlackRock/Securitize docs | SEC-registered fund, T-bills/repos |
| **USDD** | `https://usdd.io/transparency` | Real-time on-chain; TRX/sTRX/USDT collateral |
| **USDTB** | Ethena docs | ~90% BUIDL + USDC buffer |
| **M** | `https://m0.org` / Chainlink PoR feed | Minters hold T-bills, validators attest |
| **GHO** | Aave governance dashboard | Multi-collateral CDP (like DAI but Aave assets) |
| **FDUSD** | First Digital attestation page | Prescient Assurance monthly |
| **TUSD** | Moore HK daily attestation | Cash + T-bills in segregated accounts |
| **FRAX** | `https://facts.frax.finance/` | FRAX v3: sFRAX holds T-bills, repos, USDC |

---

### Task 16: Final verification

**Step 1: Verify all reserves render**

Run: `npm run dev`

Visit each coin's detail page (`/stablecoin/<id>`) and confirm the treemap appears with correct slices.

**Step 2: Spot-check percentages sum to ~100**

```bash
grep -A20 'reserves:' src/lib/stablecoins.ts | grep 'pct:' | # visual check
```

**Step 3: Full build**

Run: `npm run build`
Expected: Clean build, no errors.

---

## Completion Criteria

- 20 stablecoins (5 existing + 15 new) have `reserves` data
- All percentages sum to 95-100% (rounding is acceptable)
- Every risk classification is defensible (documented source)
- `npm run build` passes
- Each coin's treemap renders correctly on its detail page
