# Compliance Tracker

**Status: shipped.** `/compliance/` is the canonical stablecoin compliance tracker. The retired `/mica/` route is a legacy 301 redirect target only; do not keep an App Router page under `src/app/mica/`.

The page tracks sourced, public compliance posture for assessed stablecoins. It currently combines:

- EU MiCA issuer authorization metadata from each coin's `mica?: MicaProfile` block.
- U.S. GENIUS Act implementation-watch metadata from each coin's `genius?: GeniusProfile` block.

The tracker is informational and source-backed, not legal advice. Missing `mica` or `genius` metadata means "not assessed", not "out of scope" or "non-compliant".

## Architecture

Compliance metadata is static editorial metadata bundled through generated client projections:

- Source of truth: `shared/data/stablecoins/coins/*.json`
- Runtime schema: `shared/lib/stablecoins/schema.ts`
- Shared types: `shared/types/core.ts`
- Client projections: `shared/types/stablecoin-client-meta.ts`, `shared/data/stablecoins/coins.client.generated.json`, and the GENIUS-only `shared/data/stablecoins/coins.compliance.generated.json`
- Presentation helpers: `shared/lib/mica.ts`, `shared/lib/genius.ts`, `shared/lib/compliance-regime-state.ts`
- Route: `src/app/compliance/page.tsx`, `client.tsx`, `model.ts`, `loading.tsx`, `error.tsx`

No Worker endpoint, D1 table, cron job, API hook, or `next.config.ts` redirect is required.

The global client registry keeps only the short GENIUS authorization status used
outside `/compliance/`. The compliance route imports the GENIUS-only projection
for the public posture fields shown on the page: applicability basis, regulator
fields, foreign-exception posture, enforcement posture, DASP offer/sale posture,
reserve/redemption/monthly-attestation flags, latest report date, reviewer
metadata, notes, and negative-evidence review summary. The page source column
aggregates top-level references plus nested references from applicability,
foreign-exception, and negative-evidence blocks so rows with nested-only evidence
still render citations.

## Page Contract

`/compliance/` is statically exported and included in the sitemap. It uses `createClientFeaturePage()` and reads `CLIENT_TRACKED_STABLECOINS`.

The page leads with a full-width `pharos-card-shell` hero (homepage-canon alignment, 2026-06-30): the frost-blue "One Beam" is the MiCA-authorized count, with authorization-rate %, GENIUS-tracked count, and assessed-regime-row count as neutral `.pharos-numeric` sub-metrics plus a neutral GENIUS regime-state badge (`buildComplianceSummary()` in `model.ts` derives these from the unfiltered view-model — no new data source). The regime/status/type/peg filters are `pharos-control-pill`s in a `pharos-table-toolbar` above the two `pharos-table-shell` tables, which are the workbench. Compliance-status colors keep their categorical ramp (never frost).

URL filters:

- `regime=all|mica|genius`
- `status=<regime status>`
- `type=EMT|ART` for MiCA rows
- `peg=<PegCurrency>`
- `q=<search>`

Default view is `regime=all`. For legacy MiCA links, the client infers `regime=mica` when `status` is a MiCA status or `type`/`tokenType` is present.

The shared search sync is two-way: editing `q` replaces the current URL state, while browser Back/Forward navigation rehydrates the input from the active URL instead of leaving a stale local search value.

The main authorization table excludes frozen and pre-launch assets. MiCA rows can enter the main table when the coin is active and has `mica` metadata. GENIUS rows enter the main table only when the regime is effective (`GENIUS_REGIME_STATE.rulemakingPhase === "effective"`) and the coin is not pre-launch; pre-launch coins and all non-frozen coins while the regime is not yet effective remain in the separate "Implementation Watch" section (frozen coins are excluded from both the main table and Implementation Watch).

Tables show the GENIUS reserve-disclosure column whenever the displayed rows
include GENIUS entries, including the default `regime=all` Implementation Watch.
GENIUS rows also render enforcement, DASP, foreign-exception, monthly
attestation, latest report date, reviewer, reviewed date, notes, and
negative-evidence summary in compact table cells/details.

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
- reserve, redemption, and monthly-attestation disclosure presence;
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
