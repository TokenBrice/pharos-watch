# Adding a New Stablecoin

Step-by-step reference for adding a coin to `TRACKED_STABLECOINS` in `shared/lib/stablecoins.ts`. The process has nine phases; all are automatable via the skills listed below.

> **Completion gate:** Do NOT consider the job done until every phase has been evaluated. Phases 1–4 and 6–9 are mandatory for every coin. Phase 5 is a structured decision tree — evaluate every branch, skip only the ones that genuinely don't apply.

---

## Phase 0 — Eligibility check

Before starting, confirm the coin belongs on the dashboard:

| Question | Guidance |
|----------|----------|
| Is it pegged to a fiat currency (USD, EUR, etc.) or a commodity (gold, silver)? | Yes → proceed. Pure NAV-appreciation tokens with no peg target (e.g. private credit fund tokens) are **not** tracked. |
| Is its target price approximately constant (whether $1, $1+rebase, or NAV-accreting from a stable base)? | Yes → proceed. A NAV token that started at $10 and accretes is fine; one started at any price and moves with market sentiment is not. |
| Does it have a supply that is verifiably on-chain or third-party attested? | Some supply data is acceptable — no supply tracking doesn't block adding metadata. |
| Is it at least $5M in circulating supply? | Soft threshold. Below that, document why it merits tracking (e.g. strategic importance, notable issuer). |

**mF-ONE-class exclusions:** tokens that are tokenized fund shares pegged to nothing in particular (NAV drifts freely from any fiat anchor) do not belong here, regardless of RWA backing or yield-bearing characteristics.

---

## Phase 1 — Determine the ID

The `id` field uses canonical `ticker-issuer` format: lowercase ticker hyphenated with the issuer/protocol name.

**Format:** `{ticker}-{issuer}` — e.g. `usdt-tether`, `ousg-ondo-finance`, `paxg-paxos`

**Rules:**
- Lowercase, hyphen-separated: `[a-z0-9]+(-[a-z0-9]+)+`
- Multi-word issuers use hyphens: `ondo-finance`, `world-liberty-financial`
- The `ticker-issuer` pair must be globally unique
- Same ticker, different issuers is fine: `gusd-gemini` vs `gusd-gate`

**Data source fields (separate from ID):**
- If the coin is in DefiLlama's stablecoins API, set `llamaId` to its DefiLlama ID number (find via `GET https://stablecoins.llama.fi/stablecoins`)
- If the coin is on CoinGecko, set `geckoId` (find via `GET https://api.coingecko.com/api/v3/search?query={symbol}`)
- Set `detailProvider` to `"defillama"` (default), `"coingecko"` (CG-only coins), or `"commodity"` (gold/silver tokens)

---

## Phase 2 — Research (use the `stablecoin-info-fetch` skill)

Run the `stablecoin-info-fetch` skill for each coin. It handles:

- **CoinGecko API** — geckoId, contract addresses + decimals (`detail_platforms`), links
- **DefiLlama** — chain-level supply breakdown to discover missing deployments
- **Official docs/website** — collateral description, peg mechanism, jurisdiction, proof of reserves
- **Block explorer APIs** — contract address verification (Etherscan-family: `/api?module=token&action=tokeninfo`)

For batches of independent coins, dispatch parallel agents (one per coin) using `superpowers:dispatching-parallel-agents` to save time. Each agent should return a structured JSON object covering all required fields.

### Fields to collect

| Field | Required | Notes |
|-------|----------|-------|
| `geckoId` | If on CoinGecko | Used for price fallback |
| `collateral` | Yes | Specific assets, not marketing copy |
| `pegMechanism` | Yes | HOW the peg is maintained |
| `jurisdiction` | For centralized/centralized-dependent | Country, regulator, license |
| `links` | Yes | Website, Twitter, Docs, Proof of Reserve |
| `contracts` | Yes | Only chains in `shared/lib/chains.ts`; verify each address |
| `tradedContracts` | If applicable | Bridge/variant contracts tracked for flows but not primary (e.g. USDT0 on Optimism) |
| `proofOfReserves` | Yes if exists | type, url, provider |
| `backing` | Yes | `rwa-backed` / `crypto-backed` / `algorithmic` |
| `governance` | Yes | `centralized` / `centralized-dependent` / `decentralized` |
| `yieldBearing` | Yes | Does the token itself accrue yield? |
| `navToken` | Yes | Is price > $1 and appreciating? |
| `rwa` | Yes | Backed by real-world assets? |
| `canBeBlacklisted` | Yes | Can the issuer freeze/blacklist addresses? `true`, `false`, or `"possible"` |
| `dependencies` | If applicable | Does this coin wrap or depend on another tracked stablecoin? e.g. sDAI → DAI. Set `{id, weight, type}` where type is `wrapper`, `mechanism`, or `collateral` |
| `pythFeedId` | If available | Pyth Network price feed ID — enables Pyth as a price source for depeg detection |
| `commodityOunces` | For gold/silver tokens | Troy ounces per token |

### System eligibility research

In addition to metadata fields, Phase 2 must investigate these questions to drive Phase 5 decisions:

| Question | What to look for | Drives |
|----------|-----------------|--------|
| **Does the issuer publish a live reserves API or transparency page?** | Look for API endpoints, attestation feeds, on-chain proof-of-reserve contracts, or structured transparency pages that expose reserve composition data | `liveReservesConfig` (Phase 5) |
| **What yield mechanism does this coin use (if any)?** | Rebase, NAV appreciation, lending vault, fee sharing? Is there a separate yield-bearing wrapper token (e.g. USDe→sUSDe)? Is there a DefiLlama pool for it? | Yield pipeline configs (Phase 5) |
| **Is this coin deployed on Ethereum?** | Check `contracts[]` for an Ethereum address | Mint/burn tracking (Phase 5) |
| **Does Bluechip rate this coin?** | Check `bluechip.org/en/coins/{likely-slug}` | `BLUECHIP_SLUG_MAP` (Phase 5) |
| **What is the redemption route?** | Direct issuer redemption? Queue-based? Collateral unlock? PSM swap? What are the fees, settlement time, access restrictions? | Redemption backstop config (Phase 5) |

Record answers to these questions alongside the metadata — they'll be consumed in Phase 5.

---

## Phase 3 — Write the `stablecoins.ts` entry

### Helper functions

```typescript
usd(id, name, symbol, backing, governance, opts)    // USD-pegged
eur(id, name, symbol, backing, governance, opts)    // EUR-pegged
other(id, name, symbol, backing, governance, pegCurrency, opts)  // everything else
```

### Classification flags

| Flag | Values |
|------|--------|
| `backing` | `rwa-backed` \| `crypto-backed` \| `algorithmic` |
| `governance` | `centralized` \| `centralized-dependent` \| `decentralized` |
| `collateralQuality` | `native` \| `rwa` \| `eth-lst` \| `alt-lst-bridged-or-mixed` \| `exotic` |
| `custodyModel` | `onchain` \| `institutional` \| `cex` |
| `governanceQuality` | `immutable-code` \| `dao-governance` \| `multisig` \| `regulated-entity` \| `single-entity` \| `wrapper` |

Use `collateralQuality: "exotic"` when the backing has meaningful non-standard risk (e.g. crypto carry, private credit, illiquid assets). Use `governanceQuality: "regulated-entity"` for SEC/FCA/MAS-supervised issuers.

### yieldConfig

Required for all `yieldBearing: true` coins:

```typescript
yieldConfig: { yieldSource: "…", yieldType: "nav-appreciation" | "rebase" | "lending-vault" | "fee-sharing" | … }
```

Use `nav-appreciation` for tokens whose price rises over time (USYC, BUIDL, mTBILL).
Use `rebase` for tokens that stay at $1 while balances grow (USD+ by Dinari, OUSD).

### Insertion point

Add new coins just before the `// ── Additional non-USD pegs ─` section comment. For non-USD pegs, add inside the appropriate peg section.

### Quality standards for text fields

- **`collateral`**: Name specific asset types. Bad: *"U.S. dollar reserves"*. Good: *"Short-term U.S. Treasury Bills (WAM ~28 days), held in segregated non-rehypothecated accounts at BNY Mellon"*
- **`pegMechanism`**: Explain the mechanism. Bad: *"Direct redemption through issuer"*. Good: *"1:1 mint and redemption against USDC at prevailing NAV; NAV oracle updated daily by Ankura Trust"*
- **`contracts`**: Lowercase hex for EVM, original case for Tron/Solana. Verify every address via the block explorer tokeninfo API before adding.
- **`links`**: Use `x.com` not `twitter.com`. Order: Website, Twitter, Docs, Proof of Reserve.

### Example entry (minimal)

```typescript
usd("ausd-acme", "Acme Stablecoin", "AUSD", "rwa-backed", "centralized", {
  llamaId: "999", detailProvider: "defillama", geckoId: "acme-usd",
  yieldBearing: true, rwa: true, navToken: false,
  canBeBlacklisted: true,
  yieldConfig: { yieldSource: "Acme T-bill fund", yieldType: "rebase" },
  collateral: "Short-term U.S. Treasury bills held at Bank X in a bankruptcy-remote SPV",
  pegMechanism: "1:1 mint and redemption against USDC; yield distributed via on-chain rebase",
  proofOfReserves: { type: "independent-audit", url: "https://acme.io/transparency", provider: "Firm Y" },
  links: [
    { label: "Website", url: "https://acme.io" },
    { label: "Twitter", url: "https://x.com/acme" },
    { label: "Docs", url: "https://docs.acme.io" },
  ],
  jurisdiction: { country: "United States", regulator: "OCC", license: "National Trust Charter" },
  contracts: [
    { chain: "ethereum", address: "0xabc…", decimals: 6 },
  ],
  collateralQuality: "rwa",
  custodyModel: "institutional",
  governanceQuality: "regulated-entity",
  reserves: [
    { name: "Short-term U.S. Treasury Bills", pct: 100, risk: "very-low" },
  ],
}),
```

---

## Phase 4 — Fetch and add the logo

Logos are served from `public/logos/` and mapped in `data/logos.json`. Both must be updated.

### 1. Download the image file

Fetch the logo from one of these sources (in order of preference):

1. **Official project website or GitHub repo** — press kits or `assets/` folders often have high-res SVG/PNG. Use `agent-browser` or `curl` to download.
2. **CoinGecko coin page** — the thumbnail URL follows the pattern `https://assets.coingecko.com/coins/images/{n}/large/{filename}`. Find it via the CoinGecko API (`GET /api/v3/coins/{geckoId}` → `image.large`) or by inspecting the coin page.
3. **DefiLlama coin page** — check the coin's icon URL.

```bash
# Example: download from CoinGecko
curl -L "https://assets.coingecko.com/coins/images/12345/large/token-logo.png" \
  -o public/logos/ausd-acme.png
```

| File name convention | Example |
|----------------------|---------|
| `{id}.{ext}` | `usdy-ondo-finance.png` |

Accepted formats: `.svg` > `.png` > `.webp` > `.jpg`. Aim for at least 64×64 px; square or near-square crops look best in the UI.

### 2. Register it in `data/logos.json`

Add one line mapping the coin's ID to its public path:

```json
"usdy-ondo-finance": "/logos/usdy-ondo-finance.png",
```

Keep the file sorted alphabetically by key.

---

## Phase 5 — Worker-side configuration

Evaluate **every branch** below based on the system eligibility research from Phase 2. Skip a branch only when it genuinely doesn't apply to this coin.

### 5a. Contract & reserve enrichment skills

| Skill | When to use |
|-------|-------------|
| `contract-populate` | Populate contract addresses for one coin using CoinGecko `detail_platforms` |
| `contract-enrich` | Discover missing chain deployments using DefiLlama supply data across all tracked coins |
| `reserve-research` | Populate `reserves[]` composition with sourced percentages |
| `resilience-classify` | Research and set `chainTier`, `deploymentModel`, `collateralQuality`, `custodyModel` overrides |

### 5b. Live reserves

**Evaluate:** Does the coin have a live reserves API, transparency page, attestation feed, or on-chain proof-of-reserve contract?

- **Yes →** Add `liveReservesConfig` to the coin's entry in `stablecoins.ts`. Check whether an existing adapter in `worker/src/cron/reserve-adapters/index.ts` fits (currently 23+ adapters). If not, write and register a new adapter.
- **No →** Ensure the static `reserves[]` array is populated (via `reserve-research` skill). The API falls back to `curated-fallback` automatically.

`liveReservesConfig` structure:
```typescript
liveReservesConfig: {
  adapter: "adapter-key",        // registered key in reserve-adapters/index.ts
  version: 1,
  semantics: "collateral-mix",   // or "protocol-reserve" | "attestation-mix" | "single-asset"
  display: { url: "https://…/transparency", label: "Acme Transparency" },
  inputs: {
    primary: { kind: "http-json", url: "https://…/api/reserves" },
  },
},
```

See `docs/live-reserves.md` for full reference.

### 5c. Yield pipeline

**Evaluate:** Is `yieldBearing: true`? Does the coin have a yield wrapper? What yield mechanism is used?

The yield system has 4 tiers that resolve automatically in order. Most coins need no config beyond `yieldConfig` in `stablecoins.ts`. Check each level:

| Config | File | When to add |
|--------|------|-------------|
| `YIELD_POOL_MAP` | `worker/src/cron/yield-config.ts` | Map coin ID → DefiLlama pool UUID when symbol-based auto-matching is ambiguous or wrong |
| `YIELD_VARIANT_MAP` | `worker/src/cron/yield-config.ts` | Coin has a **separate yield-bearing wrapper** (e.g. USDe → sUSDe, FRAX → sFRAX). Add `{variantSymbol, variantAddress?, variantChain?, yieldSource?, yieldType?}` |
| `ON_CHAIN_RATE_CONFIGS` | `worker/src/cron/yield-config.ts` | Want precise Tier 1 on-chain vault exchange-rate APY via `eth_call` |
| `RATE_DERIVED_CONFIGS` | `worker/src/cron/yield-config.ts` | Token tracks T-bill rate minus a spread (BUIDL-pattern: fixed $1 NAV, distributes yield as new token mints) |

Non-yield-bearing coins and coins whose symbol cleanly matches a DeFiLlama pool need **no yield config beyond the metadata**.

See `docs/yield-intelligence.md` for full reference.

### 5d. Mint/burn flow tracking

**Evaluate:** Is the coin deployed on Ethereum with meaningful supply (>$10M)?

- **Yes →** Add an entry to `worker/src/lib/mint-burn-contracts.ts`. The config needs:
  - `startBlock` — contract deployment block on Ethereum
  - `dustThreshold` — minimum event amount to track
  - tier: `extended` (use `critical` only for top-6 stablecoins)
  - Token address/decimals resolve automatically from `contracts[]` in `stablecoins.ts`
- **No →** Skip. Mint/burn tracking is Ethereum-only.

See `docs/mint-burn-flows.md` for full reference.

### 5e. Bluechip rating

**Evaluate:** Does Bluechip publish a rating for this coin?

- **Yes →** Add `slug: "pharos-coin-id"` to `BLUECHIP_SLUG_MAP` in `worker/src/lib/bluechip-slugs.ts`
- **No →** Skip. Most coins don't have a Bluechip rating.

### 5f. Redemption backstops

**Evaluate:** Does this coin have a meaningful redemption route worth modeling?

- **Yes →** Add an entry to `REDEMPTION_BACKSTOP_CONFIGS` in `shared/lib/redemption-backstops.ts`. Specify `routeFamily`, `accessModel`, `settlementModel`, `executionModel`, `outputAssetType`, `capacityModel`, and `costModel`. Template helpers exist for common patterns (`issuerBase`, `collateralRedeemBase`, `queueRedeemBase`).
- **No →** Skip. The report card liquidity dimension still computes from DEX data alone.

See `docs/redemption-backstops.md` for full reference.

---

## Phase 6 — AI summary

> **This phase is mandatory.** Do not skip it.

Run the `write-ai-summaries` skill. It reads the coin's entry from `stablecoins.ts` and writes a sardonic, data-driven editorial summary to `data/ai-summaries.json`.

Key voice guidelines (see the skill for full detail):
- Ground observations in facts — market cap, backing type, governance, notable events
- Sardonic, not snarky: wit should illuminate
- No marketing language, no hedging everything
- 3–6 sentences, each one earning its place

---

## Phase 7 — Backfill supply history

Newly added coins have no historical rows in the `supply_history` table. Without a backfill the market cap chart on the detail page will be empty until tomorrow's daily snapshot cron runs (and will stay empty forever for all prior dates).

The right backfill endpoint depends on source fields, not the `id` format:

| Condition | Endpoint | What it does |
|-----------|----------|-------------|
| Coin has `llamaId` (DL-tracked) | `POST /api/backfill-supply-history?stablecoin={id}` | Reads full DL history via `/stablecoin/{llamaId}` |
| Coin has `geckoId` but no `llamaId` | `POST /api/backfill-cg-prices?stablecoin={id}` | Reads CoinGecko `market_chart` (prices + market caps) and inserts rows |
| Neither | None — no historical data available | Chart will stay empty; document this in the coin's notes |

Both endpoints require the `X-Admin-Key` header and **POST** method. Call them immediately after pushing the new entries to production.

```bash
# For a DL-tracked coin:
curl -X POST "https://api.pharos.watch/api/backfill-supply-history?stablecoin=usdy-ondo-finance" \
  -H "X-Admin-Key: $ADMIN_KEY"

# For a CoinGecko-only coin:
curl -X POST "https://api.pharos.watch/api/backfill-cg-prices?stablecoin=ousg-ondo-finance" \
  -H "X-Admin-Key: $ADMIN_KEY"
```

`backfill-cg-prices` also back-fills `price` for any existing rows that have `NULL` in that column, so it is safe to run on any coin with a `geckoId`.

**Response shape (backfill-cg-prices):**
```json
{
  "coinsProcessed": 1,
  "totalPricesFilled": 0,
  "totalRowsInserted": 365,
  "coinDetails": [{ "id": "ousg-ondo-finance", "symbol": "OUSG", "pricesFilled": 0, "rowsInserted": 365 }]
}
```

---

## Phase 8 — Verify and push

```bash
npm run build          # TypeScript compile + static export; must pass with zero errors
python3 -m json.tool data/ai-summaries.json > /dev/null  # validate JSON
npm test               # run test suite (optional but recommended)
git add shared/lib/stablecoins.ts data/ai-summaries.json data/logos.json public/logos/
git commit -m "Add {SYMBOL}: {one-line description}"
git push origin main
```

If the branch has diverged from remote, rebase before pushing:

```bash
git stash              # stash unrelated working-tree changes
git pull --rebase      # rebase local commits onto remote
git stash pop
git push origin main
```

---

## Phase 9 — Post-push completion checklist

After the code is deployed and live, verify:

- [ ] Coin appears on the homepage table with correct name, symbol, and logo
- [ ] Detail page (`/stablecoin/{id}`) loads without errors
- [ ] AI summary renders on the detail page
- [ ] Supply history backfill ran successfully (Phase 7)
- [ ] Coverage page (`/coverage/`) shows the new coin with expected coverage dots
- [ ] If live reserves were configured: check `/api/live-reserves?stablecoin={id}` returns data after the next hourly sync
- [ ] If yield was configured: check `/api/yield-rankings` includes the coin after the next yield sync

---

## Quick-reference: ID decision tree

```
1. Choose ticker-issuer ID:  {ticker}-{issuer}  (e.g. "usdy-ondo-finance")
2. Set data source fields:
   └─ In DefiLlama stablecoins API? → set llamaId + detailProvider: "defillama"
   └─ CoinGecko only?              → set geckoId + detailProvider: "coingecko"
   └─ Gold/silver token?            → set geckoId + detailProvider: "commodity"
```

## Quick-reference: governance flag

```
Who controls the peg / can pause / change reserves?
  └─ A company / single legal entity (with or without DAO veneer) → "centralized"
  └─ A protocol that depends on centralized assets (e.g. USDC collateral) → "centralized-dependent"
  └─ Immutable contracts, no admin keys, no human override → "decentralized"
```

---

## Related documentation

- `docs/classification.md` — full classification system, peg currencies, flag semantics
- `docs/data-pipeline.md` — how supply data is fetched and enriched per ID type
- `docs/yield-intelligence.md` — yieldConfig fields, APY resolution tiers, navToken behavior
- `docs/live-reserves.md` — live reserve sync config, adapter registry, storage, API modes
- `docs/redemption-backstops.md` — redemption-route configs, effective-exit scoring
- `docs/mint-burn-flows.md` — mint/burn flow tracker, contract configs, scoring
- `docs/report-cards.md` — how collateralQuality / custodyModel affect safety scores
- `shared/types/index.ts` — canonical TypeScript types for all fields
- `shared/lib/chains.ts` — supported chain identifiers for `contracts[]`
