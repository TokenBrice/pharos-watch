---
name: stablecoin-info-fetch
description: Use when asked to verify, populate, or audit a single stablecoin's detail fields (collateral, peg mechanism, jurisdiction, links, geckoId, contracts). Run per-coin to fill gaps or validate existing data in src/lib/stablecoins.ts.
user_invocable: true
---

## Stablecoin Info Fetch & Verify

Verify and populate a single stablecoin's metadata in `src/lib/stablecoins.ts`. Designed to be run sequentially — one coin at a time.

### Input

The user provides a stablecoin **name**, **symbol**, or **ID** (DefiLlama numeric or custom). If ambiguous, ask.

### Fields to Verify / Populate

| Field | Source priority | Notes |
|---|---|---|
| `collateral` | Official docs > news > web | Short factual description of backing assets |
| `pegMechanism` | Official docs > protocol analysis | How the peg is maintained (redemption, PSM, algo, delta-neutral, etc.) |
| `jurisdiction` | Official docs > legal filings > news | `{ country, regulator?, license? }` — only for centralized / centralized-dependent |
| `links` | Official site, Twitter, docs | Labels: `"Website"`, `"Twitter"`, `"Docs"`, `"Proof of Reserve"` |
| `geckoId` | CoinGecko API search > CoinGecko site | Should be populated for every tracked coin when it exists on CoinGecko |
| `cmcSlug` | CoinMarketCap | Fallback when both DL + CG miss price |
| `contracts` | Official docs > CoinGecko > block explorers | `{ chain, address, decimals }` — chains from `src/lib/chains.ts` only |
| `proofOfReserves` | Official site | `{ type, url, provider? }` — types: `"independent-audit"` / `"real-time"` / `"self-reported"` |

### Process

#### Step 1 — Read current state

1. Read `src/lib/stablecoins.ts` and locate the coin's entry
2. List which fields are **present**, **missing**, or **suspect** (vague placeholders like "U.S. dollar reserves" or "Direct redemption through issuer")
3. Note the coin's `flags` (backing, pegCurrency, governance) — these are authoritative and should NOT be changed by this skill

#### Step 2 — Research

Run these searches **in parallel** to maximize efficiency:

- **DefiLlama chain data**: `WebFetch` `https://stablecoins.llama.fi/stablecoin/{id}` (for numeric IDs) to get chain-level supply breakdown. If DL reports supply on a chain we don't have a contract for, that's a signal we're missing an address. This is the best discovery tool for multi-chain gaps
- **CoinGecko API search**: `WebFetch` `https://api.coingecko.com/api/v3/search?query={symbol}` to find/confirm the geckoId programmatically (more reliable than guessing slugs). Then fetch the coin page for contract addresses and links
- **Official website**: `WebFetch` the coin's website (from existing links or search) for: collateral description, peg mechanism docs, jurisdiction/legal info, proof of reserves
- **Web search**: `WebSearch` for `"{coin name}" stablecoin collateral mechanism jurisdiction` to find: regulatory filings, news articles, protocol docs
- **Docs site**: If a docs link exists or is found, `WebFetch` it for technical details on collateral and peg mechanism. Also look for a "Deployed Contracts", "Contract Addresses", or "Technical Reference" page — many projects publish a full multi-chain address list in their docs

For **contract addresses** specifically:
- **Official docs first**: Many projects list contract addresses in their documentation (e.g. a "Deployed Contracts" or "Contract Addresses" page). Check the docs site for this — it's the most reliable and complete source, often listing all chains at once
- **CoinGecko second**: Lists contracts per chain — cross-reference with existing entries and official docs
- **DefiLlama chain data**: If DL reports supply on a supported chain we have no contract for, actively search for that chain's contract address
- **Block explorers for verification**: For every contract address found from any source, verify on the chain's block explorer that the token name, symbol, and decimals match. This prevents adding a proxy admin, vault, or wrapper address instead of the actual token
- Only include chains defined in `src/lib/chains.ts`: ethereum, arbitrum, base, optimism, polygon, avalanche, bsc, gnosis, fantom, celo, tron
- Note that the core protocol may only live on one chain (e.g. Ethereum) while the stablecoin token itself is bridged to many chains — look for both native and bridged deployments

#### Step 2b — Verify existing data

Before presenting findings, run these checks on **existing** fields:

- **Link liveness**: `WebFetch` each existing link (website, twitter, docs) to confirm it still resolves. Flag any dead URLs, redirects to different domains, or rebranded handles
- **Proof of reserves liveness**: If a `proofOfReserves` entry exists, fetch the URL to confirm it's still live and the provider name is still correct. Attestation pages move or get replaced
- **Contract address cross-validation**: For each existing contract address, verify on the block explorer that the token name and symbol still match (catches proxy migrations or token upgrades)

#### Step 3 — Present findings

Present a structured summary to the user:

```
## {Name} ({Symbol}) — ID: {id}

### Current state
- collateral: {current value or MISSING}
- pegMechanism: {current value or MISSING}
- jurisdiction: {current value or MISSING}
- links: {list current or MISSING}
- geckoId: {current value or MISSING}
- contracts: {list current chains or MISSING}
- proofOfReserves: {current value or MISSING}

### Proposed changes
For each field that needs updating:
- **{field}**: {old value} → {new value}
  Source: {URL or reference}

### Verification issues
- {any dead links, stale PoR URLs, mismatched contract addresses found}

### No changes needed
- {fields that are already correct and complete}
```

**Important**: Flag any conflicts between sources. If unsure about a value, say so explicitly rather than guessing.

#### Step 4 — Apply changes

After user approval:

1. Edit the coin's entry in `src/lib/stablecoins.ts` using the `Edit` tool
2. Preserve the existing code style:
   - Use the `usd()` / `eur()` / `other()` helper functions (don't expand to raw `coin()`)
   - Contract addresses: lowercase hex for EVM, original case for Tron
   - Links order: Website, Twitter, Docs, Proof of Reserve (if applicable)
   - Keep entries concise — no trailing commas on last array items
3. Run `npm run build` to verify the edit compiles cleanly

### Quality Standards

- **collateral**: Should name specific asset types, not vague descriptions. Bad: "U.S. dollar reserves". Good: "Cash, cash equivalents, and short-term U.S. Treasury bills in segregated accounts"
- **pegMechanism**: Should explain HOW the peg is maintained. Bad: "Direct redemption through issuer". Good: "Direct 1:1 redemption through {issuer name} with daily settlement windows"
- **jurisdiction**: Only populate for `centralized` or `centralized-dependent` governance. Include `regulator` and `license` when publicly documented
- **contracts**: Include the **primary** deployment chain(s) where meaningful supply exists. Don't add chains with negligible or bridged supply. Cross-validate every address on a block explorer before proposing it
- **links**: Use `x.com` (not `twitter.com`). Verify URLs actually resolve before proposing them
- **geckoId**: Should be populated for every tracked coin that exists on CoinGecko. Use the CoinGecko search API (`api.coingecko.com/api/v3/search?query={symbol}`) to find the correct slug rather than guessing

### What NOT to change

- `flags` (backing, pegCurrency, governance, yieldBearing, rwa, navToken) — these are set intentionally
- `id`, `name`, `symbol` — canonical identifiers
- `supplyMethod` — requires separate technical verification
- `commodityOunces` — requires domain-specific knowledge (gold/silver peg normalization)
- `protocolSlug` / `cmcSlug` — only add if specifically identified as needed for price fallback

### Anti-Patterns

- Don't add speculative or unverified information — every field must have a source
- Don't copy marketing language for collateral descriptions — be factual and specific
- Don't add contract addresses without verifying they are the canonical token contract (not a proxy admin, vault, or wrapper)
- Don't populate jurisdiction for decentralized protocols (even if a DAO has a legal wrapper, the protocol itself may be jurisdiction-agnostic)
- Don't change existing correct data just because a different source phrases it differently
