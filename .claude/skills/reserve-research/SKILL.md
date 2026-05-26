---
name: reserve-research
description: Research and populate reserve composition data for a single stablecoin. Use when asked to add reserves data for a specific coin, or when batch-populating reserve compositions.
---

# Reserve Composition Research

## Input
User provides a stablecoin name, symbol, or ID from the tracked metadata JSON registry under `shared/data/stablecoins/coins/*.json`.

## Process

### Step 1: Read Current State

Read the coin's entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json`). Treat the runtime stablecoin re-export as import-only. Note:
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

The `ReserveRisk` type has 5 tiers. Apply these rules consistently:

| Risk | Score | Criteria |
|------|-------|----------|
| `very-low` | 100 | U.S. Treasury Bills (≤1yr), overnight reverse repos, FDIC-insured cash deposits, regulated government MMFs, cash/cash equivalents; ETH/WETH (base asset, no counterparty layer) |
| `low` | 75 | Investment-grade corporate bonds, T-bills >1yr duration, regulated stablecoins used as collateral (USDC, USDT, DAI, PYUSD, GHO), ETH LSTs (stETH, wstETH, rETH, weETH, sfrxETH), tokenized treasuries (BUIDL, USTB, USYC) |
| `medium` | 50 | BTC and wrapped/bridged BTC (WBTC, cbBTC, LBTC, tBTC), tokenized gold (PAXG, XAUT), structured / centralized-custody crypto |
| `high` | 25 | Volatile native L1 assets (SOL, BNB, TRX, HYPE, CELO, POL), perpetual futures positions, unsecured/undercollateralized loans |
| `very-high` | 5 | Governance tokens (CRV, GNO, UNI), recursive DeFi strategies (LP tokens, leveraged loops), zero-audit exotic protocols, opaque backing |

The per-symbol source of truth is `shared/lib/reserve-asset-risk.ts` (`CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL`) — consumed by every worker reserve adapter and enforced by `reserve-risk-consistency.test.ts`. When a symbol is listed there, use that tier verbatim; the rows above are the rubric for assets not yet in the canonical map.

Edge cases:
- **Delta-neutral positions** (spot + short perp): the combined position is `high` (CEX counterparty risk), even though the spot leg alone would be lower
- **Stablecoin collateral** (USDC/USDT/DAI as backing): `low` per the canonical map (dependency risk is captured by the report card's dependency dimension, not by inflating the reserve tier)
- **ETH LSTs (wstETH, rETH, weETH)**: `low` (canonical) — the LST layer sits on top of ETH, which is `very-low`
- **Tokenized T-bills (BUIDL, USYC, USTB)**: `low` (canonical) — the tokenization layer adds smart-contract/custodian risk above the very-low underlying
- **Segregated non-rehypothecated T-bill accounts**: `very-low` (bankruptcy-remote, no counterparty layering)

### Step 4: Present Findings

Format your findings as:

```
## Reserve Composition: <Coin Name> (<SYMBOL>)

**Source(s):** <URLs of attestation reports, dashboards, docs used>
**Source date:** <Date of the data (attestation date, dashboard access date)>
**Confidence:** High / Medium / Low

### Proposed `reserves` array:

\`\`\`json
"reserves": [
  { "name": "U.S. Treasury Bills", "pct": 50, "risk": "very-low" }
]
\`\`\`

### Notes:
- <Any caveats, assumptions, or data gaps>
- <Why specific risk tiers were chosen>
```

Wait for user approval before applying.

### Step 5: Apply Changes

After approval, use the Edit tool to add the `reserves` array to the coin's JSON object in the matching `shared/data/stablecoins/coins/*.json` file.

After applying data changes, regenerate `shared/data/stablecoins/coins.generated.json` and run `npm run check:stablecoin-data`. For full stablecoin additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`; `npm run build` alone is not sufficient.

## Quality Standards

- **Percentages must sum to 95-100%** (rounding acceptable, never >100)
- **Minimum 2 slices, maximum 7** (merge smaller categories into "Other" if needed)
- **Slice names must be specific**: "U.S. Treasury Bills" not "Government Securities"; "ETH / wstETH" not "Crypto"
- **Every percentage needs a source**: If the exact percentage is unknown, use the `collateral` field description to estimate and note confidence as "Medium" or "Low"
- **When data is unavailable**: If no breakdown can be found (no attestation, no dashboard, opaque reserves), report this clearly and do NOT fabricate percentages. Skip the coin.

## Batch Mode

When asked to process multiple coins, iterate through each coin one at a time. Present findings for 3-5 coins at once, get batch approval, then continue.
