# Adding a New Stablecoin

Step-by-step reference for adding a coin to `TRACKED_STABLECOINS` in `src/lib/stablecoins.ts`. The process has seven phases; all are automatable via the skills listed below.

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

The `id` field is the primary key used throughout the dashboard. Choose based on data availability:

| Situation | ID format | Example | Supply source |
|-----------|-----------|---------|---------------|
| Coin exists in DefiLlama stablecoins API | Numeric string (DefiLlama's ID) | `"129"` | DefiLlama `/stablecoin/{id}` |
| Coin is on CoinGecko but not DefiLlama | `cg-{geckoId}` | `"cg-ousg"` | CoinGecko `/coins/{geckoId}` market cap |
| Coin is on neither | Next available integer after current max | `"355"` | Manual / none |

**How to find DefiLlama ID:** `GET https://stablecoins.llama.fi/stablecoins` and search by name or symbol.
**How to find CoinGecko ID:** `GET https://api.coingecko.com/api/v3/search?query={symbol}` then match on name+symbol.

If a coin appears in DefiLlama *and* CoinGecko, always prefer the numeric DL ID — the supply pipeline reads from DL first.

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
| `contracts` | Yes | Only chains in `src/lib/chains.ts`; verify each address |
| `proofOfReserves` | Yes if exists | type, url, provider |
| `backing` | Yes | `rwa-backed` / `crypto-backed` / `algorithmic` |
| `governance` | Yes | `centralized` / `centralized-dependent` / `decentralized` |
| `yieldBearing` | Yes | Does the token itself accrue yield? |
| `navToken` | Yes | Is price > $1 and appreciating? |
| `rwa` | Yes | Backed by real-world assets? |

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

Add new coins just before the `// ── Additional non-USD pegs ─` section comment (around line 2910 in a fresh checkout). For non-USD pegs, add inside the appropriate peg section.

### Quality standards for text fields

- **`collateral`**: Name specific asset types. Bad: *"U.S. dollar reserves"*. Good: *"Short-term U.S. Treasury Bills (WAM ~28 days), held in segregated non-rehypothecated accounts at BNY Mellon"*
- **`pegMechanism`**: Explain the mechanism. Bad: *"Direct redemption through issuer"*. Good: *"1:1 mint and redemption against USDC at prevailing NAV; NAV oracle updated daily by Ankura Trust"*
- **`contracts`**: Lowercase hex for EVM, original case for Tron/Solana. Verify every address via the block explorer tokeninfo API before adding.
- **`links`**: Use `x.com` not `twitter.com`. Order: Website, Twitter, Docs, Proof of Reserve.

### Example entry (minimal)

```typescript
usd("cg-example", "Acme Stablecoin", "AUSD", "rwa-backed", "centralized", {
  geckoId: "acme-usd",
  yieldBearing: true, rwa: true, navToken: false,
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

## Phase 4 — Add the logo

Logos are served from `public/logos/` and mapped in `data/logos.json`. Both must be updated.

### 1. Place the image file

| ID type | File name convention | Example |
|---------|----------------------|---------|
| Numeric DL ID | `{id}-{symbol-lowercase}.{ext}` | `129-usdy.png` |
| `cg-` prefix | `{id}.{ext}` | `cg-ousg.png` |
| Custom string ID | `{id}.{ext}` | `gold-vro.png` |

Accepted formats: `.png`, `.svg`, `.jpg`, `.webp`. Prefer `.svg` > `.png` > `.webp` > `.jpg`. Aim for at least 64×64 px; square or near-square crops look best in the UI.

**Sources (in order of preference):**
1. Official project website or GitHub repo (often has a high-res SVG/PNG in press kits or `assets/`)
2. CoinGecko coin page (the thumbnail URL is usually `assets.coingecko.com/coins/images/{n}/large/...`)
3. DefiLlama coin page

### 2. Register it in `data/logos.json`

Add one line mapping the coin's ID to its public path:

```json
"129": "/logos/129-usdy.png",
"cg-ousg": "/logos/cg-ousg.png",
```

Keep the file sorted by key (numeric IDs first in insertion order, `cg-` and custom string IDs at the end) — this matches the existing file layout.

---

## Phase 5 — Optional enrichment skills

Run these after the base entry is in place, depending on what data is still missing:

| Skill | When to use |
|-------|-------------|
| `contract-populate` | Populate contract addresses for one coin using CoinGecko `detail_platforms` |
| `contract-enrich` | Discover missing chain deployments using DefiLlama supply data across all tracked coins |
| `reserve-research` | Populate `reserves[]` composition with sourced percentages |
| `resilience-classify` | Research and set `chainTier`, `deploymentModel`, `collateralQuality`, `custodyModel` overrides |

---

## Phase 6 — AI summary

Run the `write-ai-summaries` skill. It reads the coin's entry from `stablecoins.ts` and writes a sardonic, data-driven editorial summary to `data/ai-summaries.json`.

Key voice guidelines (see the skill for full detail):
- Ground observations in facts — market cap, backing type, governance, notable events
- Sardonic, not snarky: wit should illuminate
- No marketing language, no hedging everything
- 3–6 sentences, each one earning its place

---

## Phase 7 — Backfill supply history

Newly added coins have no historical rows in the `supply_history` table. Without a backfill the market cap chart on the detail page will be empty until tomorrow's daily snapshot cron runs (and will stay empty forever for all prior dates).

The right backfill endpoint depends on the coin's ID type:

| ID type | Endpoint | What it does |
|---------|----------|-------------|
| Numeric DL ID (e.g. `"129"`) | `POST /api/backfill-supply-history?stablecoin={id}` | Reads full DL history via `/stablecoin/{id}` |
| `cg-` prefix (e.g. `"cg-ousg"`) | `POST /api/backfill-cg-prices?stablecoin={id}` | Reads CoinGecko `market_chart` (prices + market caps) and inserts rows |
| Custom integer with no geckoId (e.g. `"355"`) | None — no historical data available | Chart will stay empty; document this in the coin's notes |

Both endpoints require the `X-Admin-Key` header and **POST** method. Call them immediately after pushing the new entries to production.

```bash
# For a DL-tracked coin (numeric ID):
curl -X POST "https://api.pharos.watch/api/backfill-supply-history?stablecoin=129" \
  -H "X-Admin-Key: $ADMIN_KEY"

# For a CoinGecko-only coin (cg- prefix):
curl -X POST "https://api.pharos.watch/api/backfill-cg-prices?stablecoin=cg-ousg" \
  -H "X-Admin-Key: $ADMIN_KEY"
```

`backfill-cg-prices` also back-fills `price` for any existing rows that have `NULL` in that column, so it is safe to run on any coin with a `geckoId` — not just `cg-` coins.

**Response shape (backfill-cg-prices):**
```json
{
  "coinsProcessed": 1,
  "totalPricesFilled": 0,
  "totalRowsInserted": 365,
  "coinDetails": [{ "id": "cg-ousg", "symbol": "OUSG", "pricesFilled": 0, "rowsInserted": 365 }]
}
```

---

## Phase 8 — Verify and push

```bash
npm run build          # TypeScript compile + static export; must pass with zero errors
python3 -m json.tool data/ai-summaries.json > /dev/null  # validate JSON
npm test               # run test suite (optional but recommended)
git add src/lib/stablecoins.ts data/ai-summaries.json data/logos.json public/logos/
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

## Quick-reference: ID decision tree

```
Does stablecoins.llama.fi/stablecoins list it?
  └─ Yes → use the numeric DefiLlama ID  (e.g. "129")
  └─ No  → Is it on CoinGecko?
              └─ Yes → use cg-{geckoId}  (e.g. "cg-ousg")
              └─ No  → use next integer after current max  (check tail of TRACKED_STABLECOINS)
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
- `docs/report-cards.md` — how collateralQuality / custodyModel affect safety scores
- `src/lib/types.ts` — canonical TypeScript types for all fields
- `src/lib/chains.ts` — supported chain identifiers for `contracts[]`
