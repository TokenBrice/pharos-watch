# Adding a Stablecoin

Reference for adding a tracked asset to Pharos.

Current source of truth is the JSON registry under `shared/data/stablecoins/`, loaded by `shared/lib/stablecoins/index.ts` and validated by `shared/lib/stablecoins/schema.ts`. Older `shared/lib/stablecoins.ts`, helper-constructor, and skill-driven workflows are obsolete.

> Completion gate: do not consider the job done until every phase below has been evaluated. The minimum normal diff is the registry JSON, `shared/data/stablecoins/canonical-order.json`, `data/logos.json`, and `data/ai-summaries.json`. If the asset needs runtime coverage, also evaluate yield, live reserves, redemption backstops, mint/burn, Bluechip, and history-backfill branches.

---

## Source Of Truth

| File | Purpose |
|------|---------|
| `shared/data/stablecoins/usd-major.json` | Major active USD-pegged assets |
| `shared/data/stablecoins/usd-minor.json` | Long-tail USD-pegged assets and most USD additions |
| `shared/data/stablecoins/non-usd.json` | Non-USD fiat pegs and `VAR` assets |
| `shared/data/stablecoins/commodity.json` | Gold/silver-pegged assets |
| `shared/data/stablecoins/canonical-order.json` | Canonical tracked order used to build `TRACKED_STABLECOINS` |
| `data/logos.json` | Static logo map used by the frontend |
| `data/ai-summaries.json` | Static editorial summaries used on detail and upcoming surfaces |

Useful repo references before editing:

- `docs/classification.md`
- `docs/data-pipeline.md`
- `docs/live-reserves.md`
- `docs/yield-intelligence.md`
- `docs/redemption-backstops.md`
- `docs/mint-burn-flows.md`
- `docs/report-cards.md`
- `docs/upcoming-page.md`
- `docs/stablecoin-detail-page.md`

---

## Guardrails

- Use canonical Pharos IDs in `ticker-issuer` format, all lowercase.
- New tracked entries belong in JSON assets, not in executable TypeScript arrays.
- New keys in `data/logos.json` and `data/ai-summaries.json` must use canonical stablecoin IDs even though legacy numeric keys still exist.
- Do not add manual supply overrides. Pharos uses DefiLlama first, then the existing fallback paths documented in `docs/data-pipeline.md`.
- Do not treat `infrastructures` and `dependencies` as interchangeable. `infrastructures` is project taxonomy; `dependencies` is the asset graph.
- Keep `reserves[]` curated even when `liveReservesConfig` exists. Curated reserves still drive dependency inference and fallback views.
- Use only chain IDs that already exist in `shared/lib/chains.ts`.
- If you add a new upstream source, new adapter family, or change a methodology surface, update the relevant verified docs and the about page in the same change.

---

## Phase 0 - Decide What You Are Adding

### 0a. Active vs pre-launch

Use the same registry for both, but the lifecycle matters:

- `status` omitted or `"active"`: included in `ACTIVE_STABLECOINS`, worker/runtime surfaces can process it.
- `status: "pre-launch"`: excluded from `ACTIVE_STABLECOINS`, appears on `/upcoming/`, and renders the pre-launch detail variant instead of the normal live detail page.

If the asset is pre-launch, also collect:

- `announcedDate`
- `expectedLaunchDate`
- `launchPhase`
- `launchPhaseDetail`
- `milestones`
- `featuredContent`
- `dateHistory` when dates changed over time

Do not expect pre-launch assets to show up in live worker-driven coverage until the status flips to active.

### 0b. Pick the correct registry file

- `usd-major.json`: only for clearly top-tier active USD assets that belong with the major cohort already curated there.
- `usd-minor.json`: default for most USD-pegged additions, including most new live assets and USD pre-launch entries.
- `non-usd.json`: non-USD fiat pegs plus `VAR`.
- `commodity.json`: `GOLD` and `SILVER`.

### 0c. Update canonical order

Every tracked asset, including pre-launch ones, must appear in `shared/data/stablecoins/canonical-order.json`.

- Insert the new ID in its intended canonical position.
- Use current market cap / strategic ordering, not simple append-only ordering.
- Pre-launch assets usually live near the tail, but they still need an explicit position.

---

## Phase 1 - Eligibility Check

Before tracking a coin, confirm it belongs on Pharos:

| Question | Guidance |
|----------|----------|
| Is it pegged to fiat, a commodity, or a macro reference? | Yes -> proceed |
| Is it meant to be price-stable or to appreciate from a stable base in a way Pharos explicitly models? | Yes -> proceed |
| Is supply observable on-chain or through a credible third-party source? | Some supply observability is enough to track metadata; full history can come later |
| Is circulating supply at least about $5M? | Soft threshold only. Smaller assets need a clear strategic reason |

Exclusions:

- free-floating NAV/fund-share tokens with no stable reference
- assets that are not meaningfully stable
- additions that would require bespoke supply overrides instead of the existing pipeline

Important current taxonomy note:

- For active tracked assets, classify backing by actual collateral base. Pharos currently does not carry standalone active `algorithmic` registry entries; use `rwa-backed` or `crypto-backed` unless there is an explicit historical/shadow-only reason not to.

---

## Phase 2 - Build The Research Packet

Do the research manually or with agents if available. Do not depend on older references to `stablecoin-info-fetch`, `write-ai-summaries`, or similar internal skills.

### Always collect

- `id`, `name`, `symbol`
- target registry file
- lifecycle status: active or pre-launch
- `flags.backing`
- `flags.pegCurrency`
- `flags.governance`
- `flags.yieldBearing`
- `flags.rwa`
- `flags.navToken`
- `collateral`
- `pegMechanism`
- `links`
- `contracts`
- `reserves`

### Collect when applicable

- `llamaId`
- `detailProvider`
- `geckoId`
- `cmcSlug`
- `protocolSlug`
- `pythFeedId`
- `pegReferenceId`
- `commodityOunces`
- `proofOfReserves`
- `jurisdiction`
- `tradedContracts`
- `dependencies`
- `canBeBlacklisted`
- `chainTier`
- `deploymentModel`
- `collateralQuality`
- `custodyModel`
- `governanceQuality`
- `infrastructures`
- `yieldConfig`
- `liveReservesConfig`
- `notices`
- `tags`
- all pre-launch metadata from Phase 0a

### Research questions you should answer up front

- Is the coin in DefiLlama stablecoins? If yes, what is its `llamaId`?
- Is it on CoinGecko? If yes, what is its `geckoId`?
- Does it have a stablecoin-specific CMC slug worth keeping as a fallback?
- Does it have a Pyth feed?
- Does it have a public reserves/transparency API or on-chain reserve proof?
- Is there a meaningful redemption route worth modeling?
- Is the token itself yield-bearing, or is yield only available through a separate wrapper?
- Is Ethereum a canonical issuance chain worth tracking for mint/burn?
- Does Bluechip publish a rating for it?
- Does it belong to an existing infrastructure cohort such as `liquity-v1`, `liquity-v2`, or `m0`?
- If the asset is active, what admits it into `/api/stablecoins` runtime cache: `llamaId`, `detailProvider: "coingecko"` with `geckoId`, `detailProvider: "coingecko"` with on-chain total-supply fallback, or commodity `geckoId`?

### Research quality rules

- Verify contract addresses against official docs and the relevant explorer.
- For EVM contracts, store lowercase hex addresses.
- Keep Solana, Tron, TON, Aptos, Sui, Near, and other non-EVM addresses in their native display form.
- Use `x.com`, not `twitter.com`.
- Prefer specific collateral descriptions over marketing copy.

---

## Phase 3 - Classify It Correctly

### Current enum surface

| Field | Current values |
|------|----------------|
| `flags.backing` | `rwa-backed` \| `crypto-backed` \| `algorithmic` |
| `flags.governance` | `centralized` \| `centralized-dependent` \| `decentralized` |
| `chainTier` | `ethereum` \| `stage1-l2` \| `mature-alt-l1` \| `established-alt-l1` \| `unproven` |
| `deploymentModel` | `single-chain` \| `canonical-bridge` \| `third-party-bridge` \| `native-multichain` |
| `collateralQuality` | `native` \| `rwa` \| `eth-lst` \| `alt-lst-bridged-or-mixed` \| `exotic` |
| `custodyModel` | `onchain` \| `institutional-top` \| `institutional-regulated` \| `institutional-unregulated` \| `institutional-sanctioned` \| `cex` |
| `governanceQuality` | `immutable-code` \| `dao-governance` \| `multisig` \| `regulated-entity` \| `single-entity` \| `wrapper` |
| `dependencies[].type` | `wrapper` \| `mechanism` \| `collateral` |
| `yieldConfig.yieldType` | `lending-vault` \| `rebase` \| `fee-sharing` \| `lp-receipt` \| `nav-appreciation` \| `governance-set` \| `lending-opportunity` |
| `infrastructures[]` | `liquity-v1` \| `liquity-v2` \| `m0` |
| `launchPhase` | `announced` \| `testnet` \| `auditing` \| `beta` \| `launching-soon` |

### Classification rules that are easy to get wrong

- `flags.backing` should describe the actual reserve base, not the marketing story.
- `flags.governance` is the coarse public taxonomy. `governanceQuality` is the finer report-card override.
- `canBeBlacklisted` only accepts `true`, `false`, or `"possible"`. Do not invent `"inherited"` in metadata; that is computed later.
- `pegReferenceId` is for NAV wrappers or derivative assets whose stability should inherit from another tracked base asset.
- `tradedContracts` is for market-traded variants that matter for discovery/liquidity/yield identity but are not the canonical supply contracts.
- `tags` is optional editorial metadata. Do not use it instead of a first-class field.

### Infrastructure taxonomy vs dependency graph

`infrastructures[]` is project taxonomy. `dependencies[]` is reserve/mechanism dependency.

Use `infrastructures[]` only when the coin directly belongs to a supported technical lineage:

- `liquity-v1`: original Liquity design, 110% liquidation threshold, Stability Pool liquidations, no ongoing borrower interest
- `liquity-v2`: BOLD-style design, user-set borrower rates, branch-style collateral markets, Stability Pools
- `m0`: built on the M0 issuance platform, minter governance, `SwapFacility`, `MExtension.sol` pattern

Important M0 rules:

- M0-built coins may or may not actually hold `m-m0` in reserves.
- `m-m0` itself is not tagged with `["m0"]`; it is the base infrastructure asset.
- A wrapper or downstream derivative should not inherit `["m0"]` automatically just because the base asset depends on M0.

Use `dependencies[]` separately to describe asset relationships:

- `wrapper`: direct 1:1 or near-1:1 wrapper on another tracked asset
- `mechanism`: the upstream asset is central to the mint/redeem mechanism
- `collateral`: the upstream asset sits in the reserves/collateral stack

### Reserve composition rules

Populate `reserves[]` with real slices, not generic prose.

- Percentages should reflect the best reviewed current mix.
- Use `coinId` when a slice is another tracked stablecoin.
- Use `depType` when the slice relationship should become a dependency.
- Keep risk tiers aligned with `docs/report-cards.md`.
- Even with `liveReservesConfig`, keep `reserves[]` up to date because fallback views and dependency logic still use it.

### When to override resilience/decentralization fields

Default inference exists, but many real assets need explicit overrides.

Override when the defaults would hide real structure, especially for:

- non-Ethereum primaries
- third-party bridge deployments
- wrapper tokens
- centralized custody around otherwise on-chain systems
- sanction-linked or CEX-held collateral
- regulated issuers that deserve `regulated-entity`

---

## Phase 4 - Edit The Registry

Add the new object to the chosen JSON file using current field names and current enum values.

### Minimal active-asset skeleton

```json
{
  "id": "ausd-acme",
  "name": "Acme USD",
  "symbol": "AUSD",
  "flags": {
    "backing": "rwa-backed",
    "pegCurrency": "USD",
    "governance": "centralized",
    "yieldBearing": false,
    "rwa": true,
    "navToken": false
  },
  "llamaId": "999",
  "detailProvider": "defillama",
  "geckoId": "acme-usd",
  "collateral": "Short-term U.S. Treasury bills held in a bankruptcy-remote vehicle",
  "pegMechanism": "1:1 mint and redemption against issuer-approved cash subscriptions",
  "links": [
    { "label": "Website", "url": "https://acme.example" },
    { "label": "X", "url": "https://x.com/acme" },
    { "label": "Docs", "url": "https://docs.acme.example" }
  ],
  "contracts": [
    { "chain": "ethereum", "address": "0xabc123...", "decimals": 6 }
  ],
  "reserves": [
    { "name": "Short-term U.S. Treasury Bills", "pct": 100, "risk": "very-low" }
  ]
}
```

### Current registry editing checklist

- Add the JSON object to the right file.
- Add the ID to `shared/data/stablecoins/canonical-order.json`.
- Keep new keys canonical and consistent with the current schema.
- For active assets, ensure there is a runtime cache admission path:
  - DefiLlama-tracked assets need `llamaId`.
  - Fiat assets not in DefiLlama need `detailProvider: "coingecko"` plus either `geckoId` or a supported on-chain total-supply contract.
  - Gold/silver assets need a `geckoId` for the commodity supplemental path.
  - Do not rely on `canonical-order.json` alone; static routes can exist before the Worker `/api/stablecoins` cache has a row.
- Use `npm run check:stablecoin-data` before moving on.

---

## Phase 5 - Evaluate Downstream Coverage Branches

Do not assume every branch applies. Evaluate each one explicitly.

### 5a. Logo and summary

New tracked coins should ship with both:

- a logo entry in `data/logos.json`
- an editorial summary entry in `data/ai-summaries.json`

See Phase 6 for exact rules.

### 5b. Live reserves

If the issuer publishes a usable transparency API, attestation feed, or on-chain reserve proof:

- add `liveReservesConfig` to the coin metadata
- reuse an existing adapter if it actually matches the source
- otherwise add a new adapter under `worker/src/cron/reserve-adapters/` and register it

Current `liveReservesConfig` rules:

- `adapter`, `version`, and `semantics` are required
- `display.url` / `display.label` should point to the public source page
- `inputs.primary` is required
- `inputs.fallbacks` is optional
- use a coin-specific `breakerScope` when the same adapter is reused against different upstream sources or params
- shared breaker scopes are only appropriate when the source is truly shared and source-invariant, such as the M0 family
- `curated-validated` must align with a tracked on-chain contract for that coin

If no live source exists:

- keep `reserves[]` populated
- do not invent a live config

### 5c. Yield intelligence

If `flags.yieldBearing` is `true`, add `yieldConfig`.

Then evaluate whether runtime config is also needed in `worker/src/cron/yield-config.ts`:

- `YIELD_POOL_MAP`: explicit DeFiLlama pool mapping
- `YIELD_VARIANT_MAP`: separate wrapper/savings token that Pharos does not track directly
- `EXPLICIT_YIELD_SOURCE_POOL_MAP`: curated exact-pool override for special assets
- `ON_CHAIN_RATE_CONFIGS`: deterministic on-chain exchange-rate APY
- `RATE_DERIVED_CONFIGS`: benchmark-minus-spread products

Notes:

- Use a real mechanism type such as `nav-appreciation`, `rebase`, or `lending-vault`.
- `lending-opportunity` is primarily a runtime-discovered publication type, not the usual static metadata choice.
- If the yield wrapper is tracked as its own coin, do not also force the base asset through `YIELD_VARIANT_MAP`.

### 5d. Redemption backstops

If the coin has a meaningful direct redemption or swap route, add a config to `shared/lib/redemption-backstops.ts` / `shared/lib/redemption-backstop-configs/*`.

Evaluate:

- route family
- access model
- settlement model
- execution model
- output asset type
- capacity model
- cost model

If the route is weak, unknown, or impossible to review cleanly, skip it rather than overstating exit quality.

### 5e. Mint/burn flows

If there is a meaningful issuance contract on a tracked chain, usually Ethereum, evaluate adding a config to `worker/src/lib/mint-burn-contracts.ts`.

Current practice:

- token identity should come from shared metadata where possible
- prefer a reviewed `startBlock` over the blanket default coverage floor
- use `tier: "extended"` by default
- reserve `tier: "critical"` for truly major coverage
- set a realistic `dustThreshold`
- add bridge-detection hints only when there is a verified reason

### 5f. Bluechip ratings

If Bluechip covers the asset, update `worker/src/lib/bluechip-slugs.ts`.

Important: the map is `bluechip-slug -> pharos-id`, not the other way around.

### 5g. Price and discovery edge cases

Evaluate whether the asset needs any of these metadata fields:

- `pythFeedId` for oracle corroboration
- `cmcSlug` when CMC fallback matters
- `protocolSlug` for commodity/protocol-backed historical TVL paths
- `tradedContracts` for market-traded variants the runtime should recognize separately
- `pegReferenceId` for derivative NAV wrappers

---

## Phase 6 - Static Assets And Editorial Copy

### 6a. Logos

Current frontend practice is a local logo file plus a static map entry.

- Put the file in `public/logos/`
- Add an entry to `data/logos.json`
- New entries should use the canonical stablecoin ID as the key
- New local filenames should preferably be `${id}.${ext}` even though many historical files use older naming

Example:

```json
"ausd-acme": "/logos/ausd-acme.png"
```

Notes:

- `data/logos.json` currently contains legacy numeric keys. Ignore that for new work.
- `scripts/fetch-logos.ts` exists, but the checked-in production map today is local `/logos/...` paths.
- If no logo exists yet, the UI can fall back to initials, but a tracked addition should ideally still ship with a real logo.

### 6b. Editorial summary

Add an entry to `data/ai-summaries.json` keyed by canonical ID:

```json
"ausd-acme": {
  "title": "Short headline",
  "text": "3-6 sentence editorial summary grounded in actual Pharos metadata and market structure.",
  "updatedAt": "2026-04-09"
}
```

Current expectations:

- keyed by canonical ID
- factual, specific, and editorial rather than marketing
- used on active detail pages and as teaser copy on `/upcoming/` when relevant

Do not reference the retired `write-ai-summaries` skill in current workflow docs or implementation notes unless you have verified it is actually available.

### 6c. Notices and tags

If the coin needs explicit user-facing caveats, add `notices`.

Use `tags` sparingly for editorial categorization, not for core classification.

---

## Phase 7 - Validate

For a normal stablecoin addition, run at least:

```bash
npm run check:stablecoin-data
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Also run anything else made relevant by your diff:

- new redemption config -> `npm run check:redemption-backstops`
- verified docs changed -> `npm run check:doc-counts`, `npm run check:verified-doc-links`, `npm run check:doc-sync`

If you added or changed a new upstream/provider or methodology-affecting runtime path, update the matching verified docs in the same change:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- the area-specific feature doc
- `/methodology` and its related changelog/timeline doc if scoring or methodology behavior changed
- the about page if a new data source was introduced

---

## Phase 8 - Merge, Push, Deploy, Then Backfill

This phase is post-validation and post-merge.

Only do the backfill after all of these are true:

- the local validation in Phase 7 passed
- the change was merged
- the merged change was pushed
- the production deploy completed

After the production deploy, backfill history for live assets:

- If the coin has `llamaId`, use `POST /api/backfill-supply-history`
- If the coin has `geckoId` but no `llamaId`, use `POST /api/backfill-cg-prices`
- If it is pre-launch, skip runtime backfills until activation

Examples:

```bash
curl -X POST "https://ops-api.pharos.watch/api/backfill-supply-history?stablecoin=ausd-acme" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

```bash
curl -X POST "https://ops-api.pharos.watch/api/backfill-cg-prices?stablecoin=ausd-acme" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

Optional:

- `backfill-supply-history` accepts `allow-constant-price-fallback=true` for specific sparse-history cases

Do not hardcode direct pushes to `main` into the process. Follow the repo's normal branch and deploy workflow.

## Phase 9 - Post-Deploy Verification

- [ ] The coin appears in the expected public surface:
  active -> homepage/table/detail
  pre-launch -> `/upcoming/` and pre-launch detail
- [ ] Logo resolves correctly
- [ ] Editorial summary renders correctly
- [ ] The detail page loads without runtime errors
- [ ] `coverage/` reflects the expected coverage state
- [ ] If `infrastructures[]` was set, the correct infrastructure hub includes the coin
- [ ] If `liveReservesConfig` was added, `GET /api/stablecoin-reserves/:id` works after the next hourly reserve sync
- [ ] If `yieldConfig` or yield runtime config was added, the asset appears correctly on `/yield/` or in the detail yield section after the next yield sync
- [ ] If a redemption backstop was added, `GET /api/redemption-backstops` includes the coin after the next hourly reserve lane
- [ ] If mint/burn coverage was added, the coin appears in `/api/mint-burn-flows` / `/api/mint-burn-events` after the next lane run
- [ ] If the asset is live and backfillable, the market-cap chart is no longer empty after Phase 8

---

## Quick Reference

### Current infrastructure values

- `liquity-v1`
- `liquity-v2`
- `m0`

### Current dependency types

- `wrapper`
- `mechanism`
- `collateral`

### Current detail providers

- `defillama`
- `coingecko`
- `commodity`

### Current proof-of-reserves types

- `independent-audit`
- `real-time`
- `self-reported`

### Current live-reserve semantics

- `collateral-mix`
- `protocol-reserve`
- `attestation-mix`
- `single-asset`

### Current reminder on active backing classification

- New active tracked assets should almost always be `rwa-backed` or `crypto-backed`
- Treat `algorithmic` as an exceptional legacy/historical category, not the default place to put unstable designs
