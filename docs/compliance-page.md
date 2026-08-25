# Compliance Tracker

Route contract for `/compliance/`, the combined public compliance workbench.

The tracker is informational and source-backed, not legal advice. Missing regime metadata means not assessed; it must not be interpreted as out of scope, authorized, or non-compliant.

## Ownership

- Route shell and metadata: `src/app/compliance/page.tsx`
- Client entry shim (client boundary only): `src/app/compliance/client.tsx`
- Client filter/search/table behavior: `src/components/compliance/compliance-client.tsx`
- Row projection, sorting, regime state, and summary: `src/lib/compliance-model.ts`
- MiCA labels/presentation: `shared/lib/mica.ts`
- GENIUS labels/presentation: `shared/lib/genius.ts`
- Effective-state owner: `shared/lib/compliance-regime-state.ts`
- Metadata source: `shared/data/stablecoins/domains/compliance/<id>.json`, merged by the catalog loader into generated client/compliance projections

The route is statically exported, indexable, and included in the sitemap. It uses checked-in editorial metadata and does not require a Worker endpoint, D1 table, cron job, or API hook.

## Page Composition

The page has three URL-backed views:

- **Overview** shows one compact directory row per assessed coin — every active coin with a MiCA or GENIUS assessment, plus pre-launch coins with a GENIUS assessment — with its peg and MiCA and GENIUS status badges. Coins with no assessment in either regime, and non-active coins, do not appear. A status badge opens the matching regime view with that status filter applied; a dash means the coin has no assessment for that regime.
- **MiCA** groups the full-detail MiCA rows into ordered status bands.
- **GENIUS** groups rows into ordered status bands while preserving the model-owned main-table versus Implementation Watch split and effective-state empty state.

`src/lib/compliance-model.ts` is the authority for view projection, band order, default-collapsed statuses, and which GENIUS rows appear in the main table versus Implementation Watch. Default-collapsed bands render as one disclosure row until expanded. Search results and specific status-filter results automatically expose matching rows in those bands.

Regime tables keep the scan surface to Coin, Status, Pathway / Type, Authority, and Issuer Entity. Rows with source, review, or (for GENIUS) reserve-disclosure detail expose a button-controlled full-width fold. The fold owns source links and, for GENIUS, review evidence and reserve-disclosure details. The Overview directory has no row folds and does not require horizontal scrolling.

The unfiltered summary hero also includes linked MiCA and GENIUS status-distribution bars. Each labeled segment opens the corresponding regime/status filter; GENIUS statuses without a positive public authorization signal are combined into the neutral "No public signal" segment.

Peg and search filters apply in all three views. Status filters appear only in regime views, and MiCA token type appears only in the MiCA view.

Do not restate regime eligibility or legal classification logic in this route doc. Canonical modeling and research rules live in:

- [mica-tracker.md](./mica-tracker.md)
- [genius-tracker.md](./genius-tracker.md)

## URL Contract

- `regime=all|mica|genius`
- `status=<regime status>`
- `type=EMT|ART` for MiCA token type
- `peg=<PegCurrency>`
- `q=<search>`

Absent `regime` selects Overview unless a legacy deep link can infer a regime from a MiCA-only status/type value or GENIUS-only status value. `COMPLIANCE_URL_SCHEMA` decodes the canonical keys plus the legacy `tokenType` and `pegCurrency` aliases; writers emit canonical `type` and `peg` parameters. Changing views clears regime-specific status and token-type state; status badges and hero segments write the destination regime and status together. Search state stays synchronized with browser Back/Forward navigation.

## Data Projection

The global client registry carries compact compliance fields used across the site. `/compliance/` additionally consumes the GENIUS-only generated projection for the public posture, regulator, disclosure, review, notes, negative-evidence, and reference fields shown in its table.

Source links combine top-level and nested references and de-duplicate them before presentation. Schema and projection changes must keep the generated client artifacts aligned.

## Legacy Route

`public/_redirects` sends `/mica` and `/mica/` to `/compliance/`, and `/mica/*` to `/compliance/:splat`. `/mica/` is not a sitemap, navigation, or App Router surface.

## Maintenance

For metadata changes, follow [mica-tracker.md](./mica-tracker.md), [genius-tracker.md](./genius-tracker.md), and the relevant research skill, then regenerate stablecoin artifacts and run stablecoin-data checks.

For route changes, verify URL normalization, both regime tables, generated projections, sitemap/metadata behavior, and route-focused tests. Update the canonical regime doc when schema or classification criteria change; keep this file focused on composition.
