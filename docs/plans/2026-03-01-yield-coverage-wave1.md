# Yield Coverage Wave 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 8 protocol-native yield coins (USDS, GHO, DAI, crvUSD, FRXUSD, DOLA, BOLD, ZCHF) to the yield intelligence pipeline, expanding coverage from 14 to 22 coins.

**Architecture:** Pure data/config addition — add `yieldBearing` flags and `yieldConfig` to 8 existing coin definitions in `stablecoins.ts`, add DL pool UUIDs and variant mappings in `yield-config.ts`, update docs. No type changes, no sync logic changes, no frontend changes.

**Tech Stack:** TypeScript, Vitest

**Design doc:** `docs/plans/2026-03-01-yield-coverage-wave1-design.md`

---

### Task 1: Add variant mappings to yield-config.ts

**Files:**
- Modify: `worker/src/cron/yield-config.ts:18-36` (YIELD_VARIANT_MAP)

**Step 1: Add 7 new entries to YIELD_VARIANT_MAP**

Add after the existing AZND entry (line 35), before the closing `};` on line 36:

```ts
  // USDS -> sUSDS (Sky Savings Rate wrapper)
  "209": {
    variantSymbol: "sUSDS",
    variantChain: "ethereum",
  },
  // GHO -> sGHO (Aave Safety Module staking wrapper)
  "118": {
    variantSymbol: "sGHO",
    variantChain: "ethereum",
  },
  // DAI -> sDAI (Dai Savings Rate wrapper)
  "5": {
    variantSymbol: "sDAI",
    variantChain: "ethereum",
  },
  // crvUSD -> scrvUSD (Curve Savings vault)
  "110": {
    variantSymbol: "scrvUSD",
    variantChain: "ethereum",
  },
  // FRXUSD -> sfrxUSD (Frax Staking wrapper)
  "235": {
    variantSymbol: "sfrxUSD",
    variantChain: "ethereum",
  },
  // DOLA -> sDOLA (Inverse Finance Savings)
  "15": {
    variantSymbol: "sDOLA",
    variantChain: "ethereum",
  },
  // BOLD -> yBOLD (Yearn vault over Liquity Stability Pool)
  "269": {
    variantSymbol: "yBOLD",
    variantChain: "ethereum",
  },
```

Note: ZCHF has no wrapper — it uses a direct Frankencoin savings pool.

**Step 2: Verify worker type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat(yield): add variant mappings for 7 new native yield coins"
```

---

### Task 2: Add DL pool UUIDs to yield-config.ts

**Files:**
- Modify: `worker/src/cron/yield-config.ts:49-97` (YIELD_POOL_MAP)

**Step 1: Add 8 new entries to YIELD_POOL_MAP**

Add after the existing yoUSD entry (line 96), before the closing `};` on line 97:

```ts

  // ── Wave 1: Native yield coins (C+ or above) ─────────────────────

  // USDS -> sUSDS - sky-lending, Ethereum, $5.3B TVL, ~4.0% APY
  "209": "d8c4eff5-c8a9-46fc-a888-057c4c668e72",

  // GHO -> sGHO - aave-v3 staking, Ethereum, $266M TVL, ~5.3% APY
  "118": "ff2a68af-030c-4697-b0a1-b62a738eaef0",

  // DAI -> sDAI - sdai native, Gnosis, $86M TVL, ~5.5% APY
  "5": "13392973-be6e-4b2f-bce9-4f7dd53d1c3a",

  // crvUSD -> scrvUSD - crvusd native savings, Ethereum, $40M TVL, ~6.7% APY
  "110": "5fd328af-4203-471b-bd16-1705c726d926",

  // FRXUSD -> sfrxUSD - frax native staking, Ethereum, $26M TVL, ~4.3% APY
  "235": "42523cca-14b0-44f6-95fb-4781069520a5",

  // DOLA -> sDOLA - inverse-finance-firm, Ethereum, $14M TVL, ~4.3% APY
  "15": "bf0f95c9-bc46-467d-9762-1d80ff50cd74",

  // BOLD -> yBOLD - yearn-finance vault, Ethereum, $4.5M TVL, ~9.8% APY
  "269": "4c29f645-12db-461f-a1d7-16900d624271",

  // ZCHF - frankencoin native savings (no wrapper), Ethereum, $7.1M TVL, ~3.8% APY
  "226": "8b427366-7bfb-4c61-88be-8dc004fdc3da",
```

**Step 2: Update the GATE comment**

Change line 40 from:
```
 * GATE: 12/15 coins matched (threshold: >=10/15).
```
to:
```
 * GATE: 20/23 coins matched (threshold: >=15/23).
```

(The 3 unmapped coins remain: BUIDL, YLDS, USDB.)

**Step 3: Verify worker type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat(yield): add DL pool UUIDs for 8 wave-1 native yield coins"
```

---

### Task 3: Add yieldBearing flag and yieldConfig to stablecoins.ts

**Files:**
- Modify: `src/lib/stablecoins.ts` — 8 coin definitions

For each coin, add `yieldBearing: true` and `yieldConfig` to the opts object. The edits are all the same pattern — add the two fields to the existing opts object of each `usd()` / `other()` call.

**Step 1: USDS (ID 209, line 235)**

In the opts object for `usd("209", "Sky Dollar", "USDS", ...)`, add after `geckoId: "usds",`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Sky Savings Rate (sUSDS)", yieldType: "governance-set" },
```

**Step 2: DAI (ID 5, line 294)**

In the opts object for `usd("5", "Dai", "DAI", ...)`, add after `geckoId: "dai",`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Dai Savings Rate (sDAI)", yieldType: "governance-set" },
```

**Step 3: GHO (ID 118, line 674)**

In the opts object for `usd("118", "GHO", "GHO", ...)`, add after `geckoId: "gho",`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Aave Safety Module (sGHO)", yieldType: "governance-set" },
```

**Step 4: crvUSD (ID 110, line 886)**

In the opts object for `usd("110", "crvUSD", "crvUSD", ...)`, add after `geckoId: "crvusd",`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Curve Savings (scrvUSD)", yieldType: "nav-appreciation" },
```

**Step 5: DOLA (ID 15, line 1008)**

In the opts object for `usd("15", "Dola", "DOLA", ...)`, add after `geckoId: "dola-usd",`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Inverse Finance Savings (sDOLA)", yieldType: "nav-appreciation" },
```

**Step 6: FRXUSD (ID 235, line 1215)**

In the opts object for `usd("235", "Frax USD", "FRXUSD", ...)`, add after `geckoId: "frax-usd",`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Frax Staking (sfrxUSD)", yieldType: "nav-appreciation" },
```

**Step 7: BOLD (ID 269, line 1861)**

In the opts object for `usd("269", "Liquity BOLD", "BOLD", ...)`, add after the opening `{`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Stability Pool (via Yearn yBOLD)", yieldType: "lending-vault" },
```

**Step 8: ZCHF (ID 226, line 2041)**

In the opts object for `other("226", "Frankencoin", "ZCHF", ...)`, add after `geckoId: "frankencoin",`:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "Frankencoin Savings", yieldType: "governance-set" },
```

**Step 9: Verify frontend type-checks and build**

Run: `npm run build`
Expected: no errors

**Step 10: Run existing tests**

Run: `npm test`
Expected: all pass (no test changes needed — tests cover pure yield-helpers functions, not config)

**Step 11: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(yield): flag 8 native yield coins as yieldBearing with yieldConfig"
```

---

### Task 4: Update documentation

**Files:**
- Modify: `docs/yield-intelligence.md` — update coin counts and pool map stats

**Step 1: Update tracked coin count**

Line 9: Change `Currently 15 coins.` to `Currently 23 coins.`

**Step 2: Update pool map stats**

Line 66: Change `12 of 15 coins mapped.` to `20 of 23 coins mapped.`

**Step 3: Update estimated volume**

Line 221: Change `~15 coins × 48 points/day × 365 days ≈ 263K rows/year.` to `~23 coins × 48 points/day × 365 days ≈ 403K rows/year.`

**Step 4: Commit**

```bash
git add docs/yield-intelligence.md
git commit -m "docs: update yield-intelligence.md for wave-1 coverage expansion (14→22 coins)"
```

---

### Task 5: Verify end-to-end

**Step 1: Run full test suite**

Run: `npm test`
Expected: all pass

**Step 2: Run frontend build**

Run: `npm run build`
Expected: clean build, no errors

**Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 4: Spot-check — verify yield coins count**

Run a quick grep to confirm exactly 22 coins now have `yieldBearing: true`:

```bash
grep -c 'yieldBearing: true' src/lib/stablecoins.ts
```

Expected: `22`
