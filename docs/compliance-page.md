# Compliance Tracker

**Status: shipped.** `/compliance/` is the canonical stablecoin compliance tracker. The retired `/mica/` route is a legacy 301 redirect target only; do not keep an App Router page under `src/app/mica/`.

The page tracks sourced, public compliance posture for assessed stablecoins. It currently combines:

- EU MiCA issuer authorization metadata from each coin's `mica?: MicaProfile` block.
- U.S. GENIUS Act implementation-watch metadata from each coin's `genius?: GeniusProfile` block.

The tracker is informational and source-backed, not legal advice. Missing `mica` or `genius` metadata means "not assessed", not "out of scope" or "non-compliant".

## Architecture

Compliance metadata is static editorial metadata bundled through the client registry:

- Source of truth: `shared/data/stablecoins/coins/*.json`
- Runtime schema: `shared/lib/stablecoins/schema.ts`
- Shared types: `shared/types/core.ts`
- Client projection: `shared/types/stablecoin-client-meta.ts` and `shared/data/stablecoins/coins.client.generated.json`
- Presentation helpers: `shared/lib/mica.ts`, `shared/lib/genius.ts`, `shared/lib/compliance-regime-state.ts`
- Route: `src/app/compliance/page.tsx`, `client.tsx`, `model.ts`, `loading.tsx`, `error.tsx`

No Worker endpoint, D1 table, cron job, API hook, or `next.config.ts` redirect is required.

## Page Contract

`/compliance/` is statically exported and included in the sitemap. It uses `createClientFeaturePage()` and reads `CLIENT_TRACKED_STABLECOINS`.

URL filters:

- `regime=all|mica|genius`
- `status=<regime status>`
- `type=EMT|ART` for MiCA rows
- `peg=<PegCurrency>`
- `q=<search>`

Default view is `regime=all`. For legacy MiCA links, the client infers `regime=mica` when `status` is a MiCA status or `type`/`tokenType` is present.

The main authorization table excludes frozen and pre-launch assets. MiCA rows can enter the main table when the coin is active and has `mica` metadata. GENIUS rows enter the main table only when the regime is effective (`GENIUS_REGIME_STATE.rulemakingPhase === "effective"`) and the coin is not pre-launch; pre-launch coins and all coins while the regime is not yet effective remain in the separate "Implementation Watch" section.

## GENIUS Modeling

**`docs/genius-tracker.md` is the source of truth** for the `genius` schema, applicability/status criteria, sourcing requirements, and legal framing — the companion to `docs/mica-tracker.md`. Read it before editing `genius` metadata.

GENIUS should not be modeled as one broad "compliant" label. The `GeniusProfile` shape keeps separate public dimensions for:

- applicability;
- authorization status;
- issuer pathway;
- regulator fields;
- foreign exception posture;
- enforcement posture;
- digital asset service provider offer/sale posture;
- reserve and redemption disclosure presence;
- dated reviewer metadata and source references.

Use `authorizationStatus: "issuer-announced-intent"` only for issuer/partner statements that do not have regulator-sourced approval or application evidence. Official approval/application statuses require regulator or Federal Register references. `no-public-authorization-found` requires a dated negative-evidence review.

GENIUS effective-date state is centralized in `shared/lib/compliance-regime-state.ts`. Update that object when final primary-regulator rules are issued or the statutory fallback effective date changes. The page renders the regime state's `sourceReferences` list when present so the effective-date posture can cite multiple regulator rulemaking sources, not only the primary OCC rulemaking page.

Use explicit `not-applicable` GENIUS rows sparingly for prominent tokenized funds, securities, wrappers, or commodity tokens that are likely to be confused with payment stablecoins. Do not bulk-mark every fund share or wrapper; missing `genius` metadata remains "not assessed", while explicit exclusions should clarify a real compliance ambiguity.

## Route Retirement

`public/_redirects` owns the `/mica` retirement:

```text
/mica/* /compliance/:splat 301
/mica/ /compliance/ 301
/mica /compliance/ 301
```

Do not list `/mica/` in the sitemap, nav, command palette, or product links.

## Maintenance

After compliance metadata edits:

```bash
npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
npm run check:stablecoin-data
npm run check:generated-artifacts
npm run check:doc-counts
```

After route or crawlability edits:

```bash
npm run typecheck
npm run build
npm run seo:check
```
