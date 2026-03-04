# wsrUSD Resurrection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Wrapped Savings rUSD (wsrUSD) as a tracked NAV-appreciating stablecoin, and remove the dead rUSD entry from the cemetery.

**Architecture:** wsrUSD is a CoinGecko-only coin (`cg-wrapped-savings-rusd`) — not in DefiLlama stablecoins. It's an ERC-4626 vault token whose price appreciates as the underlying rUSD/srUSD stack earns yield. Classified as `centralized-dependent`: permissionless on-chain contracts but collateral relies on centralized custodians/RWA issuers. APY resolved via Tier 3 price-derived (CoinGecko price history) initially.

**Tech Stack:** TypeScript, `src/lib/stablecoins.ts`, `src/lib/dead-stablecoins.ts`, `data/logos.json`, `data/ai-summaries.json`, `public/logos/`, skills: `stablecoin-info-fetch`, `contract-populate`, `write-ai-summaries`

---

## Known facts (no research needed)

- **Pharos ID:** `"cg-wrapped-savings-rusd"`
- **CoinGecko ID:** `wrapped-savings-rusd`
- **Symbol:** `wsrUSD`
- **Name:** `Wrapped Savings rUSD`
- **Ethereum contract:** `0xd3fd63209fa2d55b07a0f6db36c2f43900be3094` (ERC-4626, decimals: 18)
- **Price:** ~$1.048 (NAV-appreciating) → `navToken: true`, `yieldBearing: true`
- **Market cap:** ~$96M
- **CoinGecko platforms:** ethereum, sonic, plume-network, avalanche, binance-smart-chain, katana, unichain, sei-v2, hyperevm, solana
- **Cemetery entry to delete:** `src/lib/dead-stablecoins.ts` lines 1119–1132

---

### Task 1: Research wsrUSD via stablecoin-info-fetch skill

**Files:**
- Reference: `src/lib/stablecoins.ts` (for format patterns)
- Reference: `docs/process/adding-a-stablecoin.md` (field quality standards)

**Step 1: Invoke the stablecoin-info-fetch skill**

Run the `stablecoin-info-fetch` skill for wsrUSD. Pass the following context:
- CoinGecko ID: `wrapped-savings-rusd`
- Known Ethereum contract: `0xd3fd63209fa2d55b07a0f6db36c2f43900be3094`
- Useful URLs: `https://docs.reservoir.xyz/`, `https://docs.reservoir.xyz/security-and-compliance/smart-contract-addresses`

The skill will return structured data covering: collateral, pegMechanism, jurisdiction (if any), links, proof of reserves, governance notes, and any additional chain contracts it discovers.

**Step 2: Capture the output**

Note the returned values for:
- `collateral` — specific backing assets (what rUSD is backed by; wsrUSD wraps srUSD which wraps rUSD)
- `pegMechanism` — explain the NAV appreciation mechanism
- `proofOfReserves` — if Reservoir publishes attestations
- `links` — website, twitter, docs
- `contracts` — any chains beyond Ethereum (the skill checks DL supply data per chain)
- `governanceQuality` — `"multisig"` or `"single-entity"` (verify on-chain)
- `custodyModel` — likely `"institutional"`

**Expected:** Enough data to fill the stablecoins.ts entry in Task 2.

---

### Task 2: Add wsrUSD entry to stablecoins.ts

**Files:**
- Modify: `src/lib/stablecoins.ts` (insert after line 3071, before the `// ── Additional non-USD pegs` comment at line 3073)

**Step 1: Insert the entry**

Add immediately after the closing `}),` of the `cg-dinari-usd` entry (currently line 3071), before the `// ── Additional non-USD pegs ─` comment:

```typescript
  usd("cg-wrapped-savings-rusd", "Wrapped Savings rUSD", "wsrUSD", "rwa-backed", "centralized-dependent", {
    geckoId: "wrapped-savings-rusd",
    yieldBearing: true, rwa: true, navToken: true,
    yieldConfig: { yieldSource: "Reservoir savings vault (srUSD)", yieldType: "nav-appreciation" },
    collateral: "<FILL FROM RESEARCH>",
    pegMechanism: "<FILL FROM RESEARCH> NAV-accreting vault token (not pegged to $1); token price launched at $1.00 and appreciates as rUSD yield accrues in the srUSD vault; depositors can unwrap wsrUSD → srUSD → rUSD at any time",
    proofOfReserves: <FILL FROM RESEARCH or omit if none>,
    links: [
      { label: "Website", url: "https://reservoir.xyz" },
      { label: "Twitter", url: "https://x.com/reservoirprotocol" },
      { label: "Docs", url: "https://docs.reservoir.xyz" },
    ],
    contracts: [
      { chain: "ethereum", address: "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094", decimals: 18 },
      // <FILL remaining chains from stablecoin-info-fetch output and contract-populate>
    ],
    collateralQuality: "<FILL FROM RESEARCH>",
    custodyModel: "<FILL FROM RESEARCH>",
    governanceQuality: "<FILL FROM RESEARCH>",
  }),
```

Replace all `<FILL FROM RESEARCH>` placeholders with data from Task 1.

**Step 2: Type-check only**

```bash
npm run build 2>&1 | head -40
```

Expected: zero TypeScript errors. Fix any type issues before continuing.

**Step 3: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(stablecoins): add wsrUSD (Wrapped Savings rUSD) as NAV-appreciating tracked coin"
```

---

### Task 3: Populate multi-chain contract addresses

**Files:**
- Modify: `src/lib/stablecoins.ts` (the contracts array in the wsrUSD entry)

**Step 1: Run contract-populate skill**

Invoke the `contract-populate` skill for `cg-wrapped-savings-rusd`. It will:
- Read CoinGecko `detail_platforms` for `wrapped-savings-rusd`
- Match platforms to chains in `src/lib/chains.ts`
- Return verified addresses+decimals for each matched chain

Known CoinGecko platforms: `ethereum`, `sonic`, `plume-network`, `avalanche`, `binance-smart-chain`, `katana`, `unichain`, `sei-v2`, `hyperevm`, `solana`.

**Step 2: Update contracts array**

Replace the placeholder contracts with the full verified list. Example expected shape:

```typescript
contracts: [
  { chain: "ethereum",  address: "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094", decimals: 18 },
  { chain: "base",      address: "0x...", decimals: 18 },
  // etc — only chains that exist in src/lib/chains.ts
],
```

Do not add chains that are not in `src/lib/chains.ts` (e.g. Katana, HyperEVM, Monad may not be supported yet — skip them silently).

**Step 3: Build check**

```bash
npm run build 2>&1 | head -20
```

Expected: zero errors.

**Step 4: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(stablecoins): add wsrUSD multi-chain contract addresses"
```

---

### Task 4: Add logo

**Files:**
- Create: `public/logos/cg-wrapped-savings-rusd.{ext}` (png/svg/jpg/webp — prefer svg > png)
- Modify: `data/logos.json`

**Step 1: Download logo**

Fetch the logo from CoinGecko for `wrapped-savings-rusd`:

```
https://api.coingecko.com/api/v3/coins/wrapped-savings-rusd
```

Look at the `image.large` URL in the response. Download that image to `public/logos/cg-wrapped-savings-rusd.<ext>`.

Alternatively check the official Reservoir site (`https://reservoir.xyz`) or GitHub for a higher-quality SVG.

**Step 2: Register in logos.json**

Open `data/logos.json` and add a line at the end, inside the closing `}`, following the same pattern as the last entry:

```json
  "cg-dinari-usd": "/logos/cg-dinari-usd.png",
  "cg-wrapped-savings-rusd": "/logos/cg-wrapped-savings-rusd.png"
}
```

Keep the `cg-` keys at the end, matching the existing sort order.

**Step 3: Verify logo renders**

```bash
npm run build 2>&1 | grep -i "error\|warn" | head -10
```

Expected: zero errors.

**Step 4: Commit**

```bash
git add public/logos/cg-wrapped-savings-rusd.* data/logos.json
git commit -m "feat(logos): add wsrUSD logo"
```

---

### Task 5: Remove rUSD cemetery entry

**Files:**
- Modify: `src/lib/dead-stablecoins.ts` (delete lines 1119–1132)

**Step 1: Delete the entry**

Remove the entire object from `DEAD_STABLECOINS` at lines 1119–1132 (the `"Reservoir rUSD"` entry including its trailing comma):

```typescript
  {
    name: "Reservoir rUSD",
    symbol: "rUSD",
    logo: "rusd.png",
    pegCurrency: "USD",
    causeOfDeath: "liquidity-drain",
    deathDate: "2025-12",
    peakMcap: 88_500_000,
    epitaph: "$88M walked out the door",
    obituary:
      "Reservoir boasted about processing $285M in redemptions during November 2025 'without failure' — technically true, but the patient survived the surgery only to flatline. Supply dropped from $88M to under $700K as every dollar that could leave, did.",
    sourceUrl: "https://defillama.com/stablecoin/reservoir-stablecoin",
    sourceLabel: "DefiLlama",
  },
```

Do **not** delete the logo file `public/logos/cemetery/rusd.png` — it would break the static export if any cached page still references it. Simply leave it in place.

**Step 2: Build check**

```bash
npm run build 2>&1 | head -20
```

Expected: zero errors. If the cemetery page fails to build, check that the array still has correct commas (the entry before and after the deleted block must be syntactically clean).

**Step 3: Commit**

```bash
git add src/lib/dead-stablecoins.ts
git commit -m "feat(cemetery): resurrect Reservoir — remove rUSD cemetery entry (protocol lives as wsrUSD)"
```

---

### Task 6: Write AI summary

**Files:**
- Modify: `data/ai-summaries.json`

**Step 1: Invoke write-ai-summaries skill**

Run the `write-ai-summaries` skill for `cg-wrapped-savings-rusd`. The skill reads the coin's entry from `stablecoins.ts` and writes a sardonic, data-driven editorial summary.

Key voice guidelines (from the skill):
- Ground observations in facts — market cap (~$96M), backing type, governance, notable history (the protocol's rUSD predecessor collapsed from $88M to rubble, then rebuilt as wsrUSD)
- Sardonic, not snarky
- 3–6 sentences, each earning its place
- No marketing language

**Step 2: Validate JSON**

```bash
python3 -m json.tool data/ai-summaries.json > /dev/null && echo "JSON valid"
```

Expected: `JSON valid`

**Step 3: Commit**

```bash
git add data/ai-summaries.json
git commit -m "feat(summaries): add wsrUSD AI editorial summary"
```

---

### Task 7: Full build + test

**Files:**
- No changes — verification only

**Step 1: Full build**

```bash
npm run build 2>&1 | tail -20
```

Expected: `Export successful. Build completed.` (or equivalent success message). Zero TypeScript errors. Zero Next.js build errors.

**Step 2: Run test suite**

```bash
npm test 2>&1 | tail -30
```

Expected: All tests pass. Pay attention to:
- `critical-invariants.test.ts` — checks every tracked coin has required fields
- `stablecoin-schema-compat.test.ts` — validates schema consistency
- `reserve-coinid-validation.test.ts` — checks coinId references in reserves arrays

Fix any failures before continuing.

**Step 3: Lint**

```bash
npm run lint 2>&1 | grep -E "error|warning" | head -20
```

Expected: Zero errors (warnings acceptable if pre-existing).

---

### Task 8: Push and backfill supply history

**Step 1: Push to main**

```bash
git push origin main
```

**Step 2: Backfill CoinGecko price history**

Once the push is live on production (Cloudflare Pages auto-deploys), run the backfill. This populates `supply_history` with 365 days of CoinGecko price + market cap data so the chart on wsrUSD's detail page isn't empty.

```bash
curl -X POST "https://api.pharos.watch/api/backfill-cg-prices?stablecoin=cg-wrapped-savings-rusd" \
  -H "X-Admin-Key: $ADMIN_KEY"
```

Expected response shape:
```json
{
  "coinsProcessed": 1,
  "totalPricesFilled": 0,
  "totalRowsInserted": 365,
  "coinDetails": [{ "id": "cg-wrapped-savings-rusd", "symbol": "wsrUSD", "pricesFilled": 0, "rowsInserted": 365 }]
}
```

**Step 3: Verify on live site**

Navigate to `https://pharos.watch/stablecoin/cg-wrapped-savings-rusd` and confirm:
- Coin details page loads with name, symbol, market cap
- Market cap chart shows historical data
- Safety score / report card renders without errors
- Yield page (`/yield`) includes wsrUSD once the next 30-min yield sync runs

---

## Quick reference

| Item | Value |
|------|-------|
| Pharos ID | `cg-wrapped-savings-rusd` |
| CoinGecko ID | `wrapped-savings-rusd` |
| ETH contract | `0xd3fd63209fa2d55b07a0f6db36c2f43900be3094` |
| Insertion point | `src/lib/stablecoins.ts` after line 3071 |
| Cemetery deletion | `src/lib/dead-stablecoins.ts` lines 1119–1132 |
| Logo path | `public/logos/cg-wrapped-savings-rusd.<ext>` |
| Backfill endpoint | `POST /api/backfill-cg-prices?stablecoin=cg-wrapped-savings-rusd` |
