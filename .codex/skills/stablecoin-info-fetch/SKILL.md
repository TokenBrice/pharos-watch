---
name: stablecoin-info-fetch
description: Verify and populate one tracked stablecoin's metadata (collateral, peg mechanism, jurisdiction, links, geckoId, contracts, proofOfReserves) in `shared/data/stablecoins/coins/*.json`. Use when adding a coin, filling metadata gaps, or auditing one coin's entry.
---

# Stablecoin Info Fetch

Verify one coin's metadata with structured APIs and primary sources first, then patch the matching JSON entry under `shared/data/stablecoins/coins/*.json` with the smallest defensible diff.

## Read First

- Read the current entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json` for a canonical runtime view).
- Treat the runtime stablecoin re-export as import-only; tracked metadata edits belong in the JSON registry and must match `shared/lib/stablecoins/schema.ts`.
- **Field routing:** check `shared/data/stablecoins/domains/<domain>/<id>.json` first — once a sidecar exists, its fields must stay out of the base file (`mintAuthority` → mint-authority domain; reserves and risk-review fields, `mica`/`genius` → their domains). See `docs/process/stablecoin-research-sidecars.md`.
- If the asset is dead/cemetery-only, use `shared/data/dead-stablecoins.json` and `DeadStablecoinAssetSchema` instead of this tracked-metadata workflow.
- Read `shared/lib/chains/index.ts` if contracts may change.
- Read `docs/classification.md` or `docs/data-pipeline.md` only when those rules are directly relevant.
- Do not change `flags`, `id`, `name`, `symbol`, `detailProvider`, `status`, or `commodityOunces` unless the user explicitly asked.

## Fields In Scope

- `collateral`
- `pegMechanism`
- `jurisdiction`
- `links`
- `geckoId`
- `cmcSlug`
- `contracts`
- `proofOfReserves`
- `oneLiner` (required on every active/pre-launch coin — CI-backstopped)
- `mechanismArchetype` (use the mapping cheatsheet in `docs/process/adding-a-stablecoin.md`; `check:mechanism-archetype-coverage` backstops)
- `mintAuthority` (reviewed-or-waived for high-value active additions and pre-launch promotions; descriptive only)

## Workflow

1. Run `stablecoin-runtime-price-marketcap-gate` before active additions or pre-launch promotions; metadata completeness does not prove runtime price + market-cap fetchability.

2. Read the current coin entry and list missing or suspect fields.

3. Gather sources in parallel when possible:
- DefiLlama stablecoin detail by `llamaId`
- CoinGecko search API for slug discovery
- CoinGecko coin detail API for links, categories, and `detail_platforms`
- official site, docs, transparency page, legal page
- explorer APIs for contract verification
- verified contract source, proxy/admin reads, role registries, Safe/multisig state, bridge/OFT route docs, and issuer/backend signer docs for Mint Authority review
- secondary reporting only when official material is incomplete

4. Prefer structured APIs over page scraping. Use browser/web fallback only when the needed information is not available in an API response.

5. Verify fields:
- `collateral`: specific assets, not marketing copy
- `pegMechanism`: how the peg actually holds
- `jurisdiction`: only for centralized or centralized-dependent coins
- `links`: use stable labels such as `Website`, `Twitter`, `Docs`, `GitHub`, `Proof of Reserve`
- `geckoId`: confirm via search plus coin detail, not by guessing
- `cmcSlug`: add only when genuinely needed for price fallback
- `contracts`: verify name, symbol, and decimals before adding
- `proofOfReserves`: store `{ type, url, provider?, attestorTier?, cadence?, attestorJurisdiction?, attestorLicense? }` (`shared/types/stablecoin-meta-schemas.ts` wins on shape). `attestorTier` is required-or-waived when `type` is `independent-audit` — see the attestor-tier rules in `docs/process/adding-a-stablecoin.md`
- `mintAuthority`: if high-value or explicitly requested, either author a sourced `mintAuthority` profile or record an intentional gap. The profile must include `mintPath`, `authorityPosture`, `confidence`, `summary`, and `review`; privileged paths require `controls[]` unless confidence is `unknown`.

6. If DefiLlama reports meaningful supply on a chain that is missing from `contracts`, treat that as a gap signal and use `contract-populate` or `contract-enrich` style verification.

7. For Mint Authority, treat `tsx scripts/maintenance/audit-mint-authority.ts --coin <id>` output as a candidate queue only. Do not copy scanner output into metadata without source review. Admin mint authority belongs in `mintAuthority`, not in `canBeBlacklisted` / FreezeWatch.

8. Patch the coin's per-coin JSON file with minimal edits. If adding a new tracked coin, also keep `shared/data/stablecoins/canonical-order.json` aligned and regenerate `shared/data/stablecoins/coins.generated.json`.

9. Regenerate `shared/data/stablecoins/coins.generated.json` with `npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts`, run `node scripts/build-data/build-client-registry.mjs` (client-projected fields like `geckoId`/`proofOfReserves`/`reserves` flow into `coins.client.generated.json`), then `npm run check:stablecoin-data`; for full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`. Do not treat `npm run build` alone as sufficient.

## Guardrails

- Do not add speculative metadata.
- Use `x.com` links, not `twitter.com`, unless the project itself still uses a different canonical URL.
- Lowercase EVM addresses; preserve canonical case for non-EVM chains.
- If sources conflict, keep the current value unless a stronger primary source clearly wins.
- Mint Authority is descriptive and unscored. Missing reviewed data means the detail section is omitted; it must not be treated as safe.
- Verified Safe or multisig Mint Authority controls need threshold, signer count, and modules/guards status. If modules or guards are unknown, cap verified or probable confidence at `manual-review`.
- Adding a chain deployment to `contracts` on an active multi-chain asset creates a Safety Score V9 exit/control evidence gap unless matching `bridgeRouteRisk.routes` rows exist (risk-review sidecar) — author or flag them; do not silently expand the deployment footprint.
