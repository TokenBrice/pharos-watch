# Compliance Tracker

Route contract for `/compliance/`, the combined public compliance workbench.

The tracker is informational and source-backed, not legal advice. Missing regime metadata means not assessed; it must not be interpreted as out of scope, authorized, or non-compliant.

## Ownership

- Route shell and metadata: `src/app/compliance/page.tsx`
- Client filter/search/table behavior: `src/app/compliance/client.tsx`
- Row projection, sorting, regime state, and summary: `src/app/compliance/model.ts`
- MiCA labels/presentation: `shared/lib/mica.ts`
- GENIUS labels/presentation: `shared/lib/genius.ts`
- Effective-state owner: `shared/lib/compliance-regime-state.ts`
- Metadata source: `shared/data/stablecoins/domains/compliance/<id>.json`, merged by the catalog loader into generated client/compliance projections

The route is statically exported, indexable, and included in the sitemap. It uses checked-in editorial metadata and does not require a Worker endpoint, D1 table, cron job, or API hook.

## Page Composition

The page composes two regimes:

- EU MiCA authorization rows projected from each assessed coin's `mica` metadata
- U.S. GENIUS rows projected from the dedicated compliance client projection

`src/app/compliance/model.ts` is the authority for which rows appear in the main authorization table versus Implementation Watch. The main table contains active assets only; pre-launch GENIUS rows may appear in Implementation Watch, while frozen, quarantined, and delisted rows are excluded. GENIUS placement also depends on the centralized effective-state contract.

The route includes:

1. a summary hero derived from the unfiltered model
2. regime, status, MiCA token-type, peg, and search controls
3. the authorization table
4. Implementation Watch when applicable
5. source links and regime-state context

Do not restate regime eligibility or legal classification logic in this route doc. Canonical modeling and research rules live in:

- [mica-tracker.md](./mica-tracker.md)
- [genius-tracker.md](./genius-tracker.md)

## URL Contract

- `regime=all|mica|genius`
- `status=<regime status>`
- `type=EMT|ART` for MiCA token type
- `peg=<PegCurrency>`
- `q=<search>`

The client accepts legacy `tokenType` and `pegCurrency` aliases and writes canonical `type` and `peg` parameters. When a regime is absent, MiCA-only status/type values or GENIUS-only status values can infer the appropriate regime. Search state stays synchronized with browser Back/Forward navigation.

## Data Projection

The global client registry carries compact compliance fields used across the site. `/compliance/` additionally consumes the GENIUS-only generated projection for the public posture, regulator, disclosure, review, notes, negative-evidence, and reference fields shown in its table.

Source links combine top-level and nested references and de-duplicate them before presentation. Schema and projection changes must keep the generated client artifacts aligned.

## Legacy Route

`public/_redirects` sends `/mica`, `/mica/`, and `/mica/*` to `/compliance/`. `/mica/` is not a sitemap, navigation, or App Router surface.

## Maintenance

For metadata changes, follow [mica-tracker.md](./mica-tracker.md), [genius-tracker.md](./genius-tracker.md), and the relevant research skill, then regenerate stablecoin artifacts and run stablecoin-data checks.

For route changes, verify URL normalization, both regime tables, generated projections, sitemap/metadata behavior, and route-focused tests. Update the canonical regime doc when schema or classification criteria change; keep this file focused on composition.
