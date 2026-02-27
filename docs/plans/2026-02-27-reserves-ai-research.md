# Reserve Composition: AI-Assisted Bulk Research (Tier B) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude skill (`reserve-research`) that researches a stablecoin's reserve composition via web search and official sources, then proposes a `ReserveSlice[]` array for human review. Use it to populate reserves for ~50 mid-cap coins.

**Architecture:** Create a new skill (`.claude/skills/reserve-research/SKILL.md`) modeled on the existing `stablecoin-info-fetch` pattern. The skill will: (1) read the coin's existing metadata from `stablecoins.ts`, (2) web-search for reserve/collateral breakdowns, (3) visit transparency pages and attestation reports, (4) propose a `reserves` array with sources, (5) apply after human approval. No new components or types needed.

**Tech Stack:** Claude skill (markdown), WebSearch, WebFetch, agent-browser, Edit tool.

---

## Context

### Existing Skill Pattern
The `stablecoin-info-fetch` skill at `.claude/skills/stablecoin-info-fetch/SKILL.md` follows this pattern:
1. Read current state of coin in `stablecoins.ts`
2. Research in parallel (DefiLlama, CoinGecko, official docs, web search)
3. Verify findings cross-reference
4. Present structured findings → user approves → apply via Edit

The `reserve-research` skill will follow the same structure but focus exclusively on the `reserves` field.

### Data Structure
```typescript
// src/lib/types.ts:72-77
type ReserveRisk = "low" | "medium" | "high";
interface ReserveSlice {
  name: string;      // e.g. "U.S. Treasury Bills"
  pct: number;       // percentage (should sum to ~100)
  risk: ReserveRisk; // low=green, medium=amber, high=red
}
```

### Risk Classification Reference
| Risk | Assets |
|------|--------|
| `low` | U.S. Treasuries, overnight repos, FDIC deposits, regulated MMFs, cash, government securities |
| `medium` | ETH, BTC, wstETH, WBTC, institutional-grade RWA, corporate bonds, regulated stablecoins as collateral (USDC, USDT) |
| `high` | Altcoins (SOL, TRX, etc.), perpetual futures positions, unsecured loans, exotic DeFi positions, unregulated assets |

### Target Coins (~50 mid-cap coins without reserves)

All coins in `src/lib/stablecoins.ts` that:
- Don't already have `reserves` defined
- Are NOT in the top 20 (those are handled by Tier A manual curation)
- Have a `collateral` field (i.e., we know what they hold, just not the percentages)

---

### Task 1: Create the `reserve-research` skill

**Files:**
- Create: `.claude/skills/reserve-research/SKILL.md`

**Step 1: Write the skill file**

```markdown
---
name: reserve-research
description: Research and populate reserve composition data for a single stablecoin. Use when asked to add reserves data for a specific coin, or when batch-populating reserve compositions.
---

# Reserve Composition Research

## Input
User provides a stablecoin name, symbol, or ID from `src/lib/stablecoins.ts`.

## Process

### Step 1: Read Current State

Read the coin's entry in `src/lib/stablecoins.ts`. Note:
- `collateral` field (text description of backing — this is your starting hypothesis)
- `pegMechanism` field
- `flags.backing` (rwa-backed | crypto-backed | algorithmic)
- `flags.governance` (centralized | centralized-dependent | decentralized)
- `proofOfReserves` (if present, this is your primary source)
- Whether `reserves` already exists (if so, verify rather than replace)

### Step 2: Research Reserve Breakdown

Run these research tasks in parallel:

1. **Official transparency page**: If `proofOfReserves.url` exists, visit it with WebFetch (fallback to agent-browser on 403). Extract the latest reserve breakdown percentages.

2. **Web search**: Search for `"<coin name> reserve composition breakdown <current year>"` and `"<coin symbol> attestation report reserves"`. Look for:
   - Monthly/quarterly attestation PDFs
   - Real-time transparency dashboards
   - Blog posts announcing reserve changes
   - Audit firm reports (Deloitte, KPMG, BDO, Moore, Prescient)

3. **Protocol-specific sources**:
   - For DeFi protocols: Check docs for collateral ratio pages, Dune dashboards
   - For RWA-backed: Check SEC filings, fund fact sheets
   - For delta-neutral: Check transparency dashboards showing position breakdown

4. **DefiLlama protocol page**: If `protocolSlug` exists, check `https://defillama.com/protocol/<slug>` for TVL composition data.

### Step 3: Classify Risk Tiers

Apply these rules consistently:

| Risk | Criteria |
|------|----------|
| `low` | U.S. Treasuries (any duration ≤1yr), overnight repos, FDIC-insured deposits, regulated government MMFs, cash/cash equivalents, Chainlink-verified PoR |
| `medium` | ETH, BTC, wstETH, WBTC, investment-grade corporate bonds, regulated stablecoins used as collateral (USDC, USDT), T-bills >1yr duration, tokenized treasuries (BUIDL, USYC) |
| `high` | Altcoins (SOL, TRX, AVAX, etc.), perpetual futures positions, unsecured/undercollateralized loans, exotic DeFi (LP tokens, recursive strategies), anything with <1yr track record |

Edge cases:
- **Delta-neutral positions** (spot + short perp): The spot side is `medium` (crypto), but the combined position is `high` (counterparty risk on CEX)
- **Stablecoin collateral** (USDC/USDT as backing): `medium` (not low — introduces dependency risk)
- **LSTs (wstETH, rETH)**: `medium` (smart contract + slashing risk on top of ETH)
- **Tokenized T-bills (BUIDL, USYC, USTB)**: `medium` (the underlying is low-risk but the tokenization layer adds smart contract/custodian risk)

### Step 4: Present Findings

Format your findings as:

```
## Reserve Composition: <Coin Name> (<SYMBOL>)

**Source(s):** <URLs of attestation reports, dashboards, docs used>
**Source date:** <Date of the data (attestation date, dashboard access date)>
**Confidence:** High / Medium / Low

### Proposed `reserves` array:

\`\`\`typescript
reserves: [
  { name: "<Asset Category>", pct: <number>, risk: "<tier>" },
  // ...
],
\`\`\`

### Notes:
- <Any caveats, assumptions, or data gaps>
- <Why specific risk tiers were chosen>
```

Wait for user approval before applying.

### Step 5: Apply Changes

After approval, use the Edit tool to add the `reserves` array to the coin's entry in `src/lib/stablecoins.ts`. Place it as the last field before the closing `})`.

Verify: `npm run build` succeeds.

## Quality Standards

- **Percentages must sum to 95-100%** (rounding acceptable, never >100)
- **Minimum 2 slices, maximum 7** (merge smaller categories into "Other" if needed)
- **Slice names must be specific**: "U.S. Treasury Bills" not "Government Securities"; "ETH / wstETH" not "Crypto"
- **Every percentage needs a source**: If the exact percentage is unknown, use the `collateral` field description to estimate and note confidence as "Medium" or "Low"
- **When data is unavailable**: If no breakdown can be found (no attestation, no dashboard, opaque reserves), report this clearly and do NOT fabricate percentages. Skip the coin.

## Batch Mode

When asked to process multiple coins, iterate through each coin one at a time. Present findings for 3-5 coins at once, get batch approval, then continue.
```

**Step 2: Verify skill is discoverable**

Run: `ls .claude/skills/reserve-research/`
Expected: `SKILL.md` exists.

**Step 3: Commit**

```bash
git add .claude/skills/reserve-research/SKILL.md
git commit -m "feat(skills): add reserve-research skill for AI-assisted reserve data population"
```

---

### Task 2: Pilot run — research 3 coins to validate the skill

**Files:**
- Modify: `src/lib/stablecoins.ts` (3 coin entries)

**Step 1: Invoke the skill for a well-documented coin**

Use the `reserve-research` skill on **PYUSD** (ID 120) — a centralized, RWA-backed coin with a known Paxos attestation. This validates the skill works for the easy case.

**Step 2: Invoke for a crypto-backed coin**

Use the skill on **GHO** (ID 118) — a DeFi coin backed by Aave V3 collateral. This tests the skill's ability to handle multi-asset CDP-style reserves.

**Step 3: Invoke for a less-documented coin**

Use the skill on **crvUSD** (ID 110) — crypto-backed with LLAMMA. Tests handling of exotic collateral.

**Step 4: Review output quality**

Check that:
- Sources are real URLs that load
- Percentages come from actual data, not fabrication
- Risk tiers follow the classification guide consistently
- The format is clear enough for quick human review

**Step 5: Apply approved reserves and commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(reserves): add PYUSD, GHO, crvUSD reserves via AI research skill"
```

---

### Task 3: Batch process RWA-backed centralized coins (~25 coins)

**Files:**
- Modify: `src/lib/stablecoins.ts`

These coins have the most predictable reserve structures (cash + treasuries + repos) and the most available attestation data.

**Step 1: Identify targets**

All coins matching `rwa-backed` + `centralized` that don't yet have `reserves`:
- USD1, PYUSD, USYC, USDG, RLUSD, USDY, BUIDL, USDTB, M, FDUSD, TUSD, A7A5, EURC, YLDS, AUSD, BRZ, GUSD (Gate), Gemini GUSD, USDP, MNEE, TBILL, USDH, USDO, cgUSD, EURCV, AEUR, EURI, EURS, VEUR, EURR, EUROP, EURQ, EURAU, VCHF, VGBP, tGBP, ZARP, CADC, XSGD, GYEN, AUDD, JPYC, and gold/silver coins (XAUT, PAXG, KAU, XAUm, VRO, CGO, DGLD, KAG)

**Step 2: Process in batches of 5**

Invoke the `reserve-research` skill for 5 coins at a time. Present findings, get approval, apply, commit.

**Step 3: Commit per batch**

```bash
git commit -m "feat(reserves): add reserve compositions for <batch description>"
```

---

### Task 4: Batch process crypto-backed coins (~20 coins)

**Files:**
- Modify: `src/lib/stablecoins.ts`

These are harder — more diverse collateral, fewer formal attestations, more reliance on protocol dashboards.

**Step 1: Identify targets**

All `crypto-backed` coins without `reserves`:
- USDf, USDD, GHO, USR, crvUSD, USX, USDA (Avalon), DOLA, IUSD, USDF (Astherus), DUSD, satUSD, FRXUSD, rwaUSDi, reUSD, BOLD, HYUSD, LUSD, fxUSD, MIM, HONEY, USDB, SUSD, LISUSD, REUSD, BUCK, EURA, meUSD, UTY, MSUSD, NUSD, YZUSD, ALUSD, FEUSD, OUSD, BtcUSD, USBD, etc.

**Step 2: Process in batches of 5**

Same pattern: research → present → approve → apply → commit.

**Step 3: Handle "no data available" cases**

For coins where no reserve breakdown can be found, document this in the skill output and skip them. Do not fabricate data.

---

### Task 5: Final verification

**Step 1: Count coverage**

```bash
grep -c 'reserves:' src/lib/stablecoins.ts
```

Target: 40-60 coins with reserves (5 existing + 35-55 new).

**Step 2: Build check**

Run: `npm run build`
Expected: Clean build.

**Step 3: Spot-check treemaps**

Run: `npm run dev`
Visit 5-10 coin detail pages and confirm treemaps render correctly.

**Step 4: Commit**

Final commit with any remaining fixes.

---

## Completion Criteria

- `reserve-research` skill exists and is documented at `.claude/skills/reserve-research/SKILL.md`
- 40-60 coins have `reserves` data (up from 5)
- Every `reserves` entry has a documented source (attestation URL, dashboard, or docs)
- Coins where data was unavailable are clearly identified (not skipped silently)
- `npm run build` passes
- Treemaps render correctly on coin detail pages
