---
name: reserve-research
description: Research and populate reserve composition data for a single stablecoin. Use when asked to add reserves data for a specific coin, or when batch-populating reserve compositions.
---

# Reserve Composition Research

## Input
User provides a stablecoin name, symbol, or ID from the tracked metadata JSON shards under `shared/data/stablecoins/`.

## Process

### Step 1: Read Current State

Read the coin's entry in `shared/data/stablecoins/{usd-major,usd-minor,non-usd,commodity,pre-launch}.json`. Treat the runtime stablecoin re-export as import-only. Note:
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
| `very-low` | 100 | U.S. Treasury Bills (≤1yr), overnight reverse repos, FDIC-insured cash deposits, regulated government MMFs, cash/cash equivalents |
| `low` | 75 | Investment-grade corporate bonds, FDIC deposits with concentration risk, Chainlink-verified PoR with transparent composition, T-bills >1yr duration |
| `medium` | 50 | ETH, BTC, wstETH, WBTC, regulated stablecoins used as collateral (USDC, USDT), tokenized treasuries (BUIDL, USYC, USTB) |
| `high` | 25 | Altcoins (SOL, TRX, AVAX, etc.), perpetual futures positions, unsecured/undercollateralized loans |
| `very-high` | 5 | Recursive DeFi strategies (LP tokens, leveraged loops), zero-audit exotic protocols, anything with <6mo track record and opaque backing |

Edge cases:
- **Delta-neutral positions** (spot + short perp): The spot side is `medium` (crypto), but the combined position is `high` (counterparty risk on CEX)
- **Stablecoin collateral** (USDC/USDT as backing): `medium` (not low — introduces dependency risk)
- **LSTs (wstETH, rETH)**: `medium` (smart contract + slashing risk on top of ETH)
- **Tokenized T-bills (BUIDL, USYC, USTB)**: `medium` (the underlying is very-low but the tokenization layer adds smart contract/custodian risk)
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

After approval, use the Edit tool to add the `reserves` array to the coin's JSON object in the matching `shared/data/stablecoins/*.json` shard.

Verify: `npm run build` succeeds.

## Quality Standards

- **Percentages must sum to 95-100%** (rounding acceptable, never >100)
- **Minimum 2 slices, maximum 7** (merge smaller categories into "Other" if needed)
- **Slice names must be specific**: "U.S. Treasury Bills" not "Government Securities"; "ETH / wstETH" not "Crypto"
- **Every percentage needs a source**: If the exact percentage is unknown, use the `collateral` field description to estimate and note confidence as "Medium" or "Low"
- **When data is unavailable**: If no breakdown can be found (no attestation, no dashboard, opaque reserves), report this clearly and do NOT fabricate percentages. Skip the coin.

## Batch Mode

When asked to process multiple coins, iterate through each coin one at a time. Present findings for 3-5 coins at once, get batch approval, then continue.
