# Infrastructure Tagging (Liquity v1/v2 + M0)

## Problem

The dashboard recognises Liquity v1 and v2 forks via a two-tier `protocolFamily` + `protocolVariant` taxonomy on `StablecoinMeta`. Thirteen coins carry the tag today, surfaced as a chip on the detail hero card, a "Liquity Forks" filter on the homepage, and three taxonomy pages under `/stablecoins/protocol/liquity*`.

The same conceptual axis — *what shared technical foundation does this stablecoin inherit from?* — applies to a growing number of coins built on the [M0](https://www.m0.org) issuance platform. M0 provides a permissionless smart-contract stack (minter governance, `SwapFacility`, `MExtension.sol` pattern) that downstream issuers use to launch branded stablecoins. Pharos already tracks at least seven M0-powered coins but does not surface that relationship anywhere in the UI.

The Liquity-fork system needs to be generalised so it can recognise multiple infrastructures, starting with M0.

## Solution

Replace the single-valued `protocolFamily` / `protocolVariant` pair with a flat array `infrastructures: Infrastructure[]`. Repurpose every Liquity-fork-specific UI surface (badge, filter group, taxonomy pages, methodology copy) as a generic "Infrastructure" axis, extend it with an `m0` value, and migrate the existing 13 Liquity entries plus 7 already-tracked M0 entries in the same change.

The `dependencies[]` field that already records `{id: "m-m0", type: "wrapper" | "mechanism"}` on a few coins stays untouched — it describes the **asset graph** (what's in the reserves) and is orthogonal to the new `infrastructures[]` field, which describes the **project taxonomy** (what platform the coin was built on).

## Conceptual scope

Liquity entries indicate **code lineage** — a forked CDP/Stability-Pool implementation. Forks have independent reserves and an independent operational team; they share only the source code they branched from.

M0 entries indicate **issuance-platform lineage** — the coin uses M0's smart-contract rails (minter governance, `SwapFacility`, `MExtension.sol`) for mint/burn. Reserve composition is set by the issuer and **may or may not include `$M`** — some M0-built coins are simple `$M` wrappers, others manage diversified collateral via M0's machinery. The methodology copy must say this explicitly to avoid misleading readers about the backing.

These are different correlation models, but they answer the same user question and deserve the same UI surface.

## Data model

### Type definitions

In `shared/types/core.ts`:

```ts
export type Infrastructure = "liquity-v1" | "liquity-v2" | "m0";

export const INFRASTRUCTURE_VALUES: readonly Infrastructure[] = [
  "liquity-v1",
  "liquity-v2",
  "m0",
] as const;

export const INFRASTRUCTURE_LABELS: Record<Infrastructure, string> = {
  "liquity-v1": "Liquity v1",
  "liquity-v2": "Liquity v2",
  "m0": "M0",
};

interface StablecoinMeta {
  // …existing fields…
  infrastructures?: Infrastructure[];
}
```

The flat union is intentional: it keeps the data shape simple, makes the JSON readable, and matches how the user thinks about the axis ("Liquity v1, Liquity v2, M0 are all siblings"). Future infrastructures (e.g., a hypothetical `agora-platform`) extend the union by one string.

The field is an **array** even though no coin currently belongs to two infrastructures, because the model should not block a future "this coin is both an M0 extension AND a Liquity fork" case from being expressible. The default and most common cardinality is one element.

### Filter tag generation

`getFilterTags()` in `shared/types/core.ts` emits one tag per array element:

```ts
for (const infra of meta.infrastructures ?? []) {
  tags.push(`infrastructure-${infra}` as FilterTag);
}
```

The `as FilterTag` cast is needed because the template-literal expansion isn't automatically narrowed against the `FilterTag` union; the three explicit members `infrastructure-liquity-v1` / `infrastructure-liquity-v2` / `infrastructure-m0` must also be added to the `FilterTag` union literal definition for the cast to be safe.

No synthetic "rollup" tag (e.g., `infrastructure-liquity` parent of v1/v2). The user explicitly chose the flat sibling model in brainstorming. Three tags exist:

- `infrastructure-liquity-v1`
- `infrastructure-liquity-v2`
- `infrastructure-m0`

The `FilterTag` union in `core.ts:265-268` is updated accordingly. The old `liquity-family`, `liquity-v1`, `liquity-v2`, `liquity-style` members are removed.

### Old fields are deleted

`protocolFamily` and `protocolVariant` are removed from `StablecoinMeta`, the `ProtocolFamily` and `ProtocolVariant` type aliases are deleted, and the existing 13 entries are migrated in the same PR. There is no shim or backwards-compat layer — the fields are internal to the codebase. The `style` variant (zero coins today) is dropped.

## Data migration

### Liquity (13 coins, currently in `shared/data/stablecoins/usd-minor.json`)

Each entry currently has:
```json
"protocolFamily": "liquity",
"protocolVariant": "v1"
```
becomes:
```json
"infrastructures": ["liquity-v1"]
```

| Coin id | New value |
|---|---|
| `satusd-river` | `["liquity-v1"]` |
| `lusd-liquity` | `["liquity-v1"]` |
| `meusd-mezo` | `["liquity-v1"]` |
| `btcusd-btcfi` | `["liquity-v1"]` |
| `usbd-bima` | `["liquity-v1"]` |
| `bold-liquity` | `["liquity-v2"]` |
| `nect-beraborrow` | `["liquity-v2"]` |
| `usdaf-asymmetry` | `["liquity-v2"]` |
| `usnd-nerite` | `["liquity-v2"]` |
| `usdq-quill` | `["liquity-v2"]` |
| `usdk-orki` | `["liquity-v2"]` |
| `ebusd-ebisu` | `["liquity-v2"]` |
| `feusd-felix` | `["liquity-v2"]` |

### M0 (7 coins)

Add `"infrastructures": ["m0"]` to:

| Coin id | File | Already has `m-m0` dependency? |
|---|---|---|
| `usdsc-startale` | `usd-minor.json` | yes (wrapper) |
| `ctusd-citrea` | `usd-minor.json` | yes (mechanism) |
| `usdat-saturn` | `usd-minor.json` | yes (wrapper) |
| `usdn-noble` | `usd-minor.json` | no |
| `musd-metamask` | `usd-minor.json` | no |
| `usd0-usual` | `usd-major.json` | no (UsualM referenced inside reserves block, no top-level dep) |
| `usdai-usd-ai` | `usd-major.json` | no — confirmed M0 via [M0 research post](https://research.m0.org/research/usdai-uses-m0s-stablecoin-platform-to-launch-composable-synthetic-dollar) |

`susdai-usd-ai` (Staked USDai) inherits via the `dependencies` graph and does **not** receive an explicit `infrastructures` entry — it's a derivative wrapper of `usdai-usd-ai`, not directly built on M0.

The `m-m0` token entry itself does **not** receive an `infrastructures` value — it *is* the infrastructure, not an extension.

Adding the missing `dependencies: [{id: "m-m0", ...}]` entries to the four undertagged coins is **out of scope** for this change. That belongs to the asset-graph layer and will be handled separately by the contract-enrich/reserve-research pipeline.

## Computation layer

### `shared/lib/protocol-family.ts` → `shared/lib/infrastructure.ts`

Rename the file and rewrite:

```ts
import type { Infrastructure } from "@shared/types/core";
import { INFRASTRUCTURE_LABELS } from "@shared/types/core";

export function getInfrastructureLabel(value: Infrastructure): string {
  return INFRASTRUCTURE_LABELS[value];
}

export function getInfrastructureSummary(value: Infrastructure): string {
  switch (value) {
    case "liquity-v1":
      return "Built on the original Liquity design: 110% liquidation threshold, Stability Pool liquidations, no ongoing borrower interest. Forked codebase with independent reserves.";
    case "liquity-v2":
      return "Built on the Liquity v2 / BOLD design: user-set borrower rates, branch-style collateral markets, Stability Pools. Forked codebase with independent reserves.";
    case "m0":
      return "Built on the M0 issuance platform: minter governance, SwapFacility, and the MExtension.sol contract pattern. Reserve composition is set by the issuer and may or may not include the underlying $M token.";
  }
}
```

The old `getProtocolFamilyLabel` / `getProtocolFamilySummary` functions and the `PROTOCOL_FAMILY_LABELS` / `PROTOCOL_VARIANT_LABELS` constants are removed.

### `getFilterTags()` (in `shared/types/core.ts`)

The Liquity-specific block at `core.ts:417-445` is replaced with the array iteration shown in the **Filter tag generation** section above. Net code reduction.

## Display layer

### Hero card badge

`src/components/stablecoin-detail/hero-card.tsx`:

- Rename `LiquityForkBadge` (line 121) → `InfrastructureBadge`.
- Generic prop: `{ value: Infrastructure }`.
- Renders one chip per array element. When `meta.infrastructures` has length > 1, multiple chips render side-by-side in the tertiary metrics row (line 183).
- Colour: Liquity values keep the existing `text-frost-blue / border-frost-blue/30 / bg-frost-blue/10` palette. M0 uses a violet accent — `text-violet-400 / border-violet-500/30 / bg-violet-500/10` (or whichever violet token already exists in the Tailwind theme; verify in `tailwind.config.ts` and the token map before settling).
- Label format: `Infrastructure · Liquity v1`, `Infrastructure · Liquity v2`, `Infrastructure · M0`. The "Infrastructure" prefix mirrors the current "Liquity Fork" label structure and disambiguates against the protocol-name field.
- The exclusion list at `hero-card.tsx:294-298` (excluding `bold-liquity` and `lusd-liquity` from the fork badge — because they're the originals, not forks) needs to be reconsidered: do `bold-liquity` and `lusd-liquity` get the badge in the new world? **Decision: yes.** They are reference implementations of their respective Liquity versions, and the new label says "Infrastructure: Liquity v1" not "Liquity Fork", which is accurate. Drop the exclusion.

### Filter group

`src/hooks/use-homepage-filters.ts:30-32`:

```ts
{
  key: "infrastructure",
  label: "Infrastructure",
  options: ["infrastructure-liquity-v1", "infrastructure-liquity-v2", "infrastructure-m0"],
},
```

URL key changes from `?liquity forks=` (lowercase, space-encoded) to `?infrastructure=`. No backwards-compat redirect for the URL param — query strings are not crawled the same way as paths and the Liquity Forks filter is unlikely to have meaningful inbound link share.

### Filter bar label overrides

`src/components/filter-bar.tsx:15-16`:

The current overrides `"liquity-v1": "v1"`, `"liquity-v2": "v2"` are removed. The full label ("Liquity v1") is fine within the "Infrastructure" group — there's no longer a parent label saying "Liquity Forks" that would make "v1" feel redundant.

### Filter tag labels

`shared/types/core.ts` `FILTER_TAG_LABELS` (line 323):

```ts
"infrastructure-liquity-v1": "Liquity v1",
"infrastructure-liquity-v2": "Liquity v2",
"infrastructure-m0": "M0",
```

Old `liquity-*` keys are removed.

### Stablecoin table logic & tests

`src/components/stablecoin-table-logic.ts:56` already calls `getFilterTags()` and needs no change beyond consuming the new tag set.

## Navigation layer

### Taxonomy pages

`src/lib/stablecoin-taxonomy.ts:138-197` is rewritten:

- Drop the `liquity-family` entry (no rollup page).
- Add `m0` entry alongside `liquity-v1` and `liquity-v2`.
- The constants `PROTOCOL_TAXONOMY_PAGES`, `PROTOCOL_TAXONOMY_PAGE_BY_SLUG`, `buildProtocolTaxonomyUrl()`, `PROTOCOL_CONTENT` are renamed to `INFRASTRUCTURE_TAXONOMY_PAGES`, `INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG`, `buildInfrastructureTaxonomyUrl()`, `INFRASTRUCTURE_CONTENT`.
- The `ProtocolTaxonomyValue` type alias becomes `InfrastructureTaxonomyValue` and aligns with `Infrastructure`.

### URL structure

| Old path | New path |
|---|---|
| `/stablecoins/protocol/liquity/` | (removed — no rollup page) |
| `/stablecoins/protocol/liquity-v1/` | `/stablecoins/infrastructure/liquity-v1/` |
| `/stablecoins/protocol/liquity-v2/` | `/stablecoins/infrastructure/liquity-v2/` |
| (new) | `/stablecoins/infrastructure/m0/` |

The Next.js route directory `src/app/stablecoins/protocol/[protocol]/` is renamed to `src/app/stablecoins/infrastructure/[infrastructure]/`. The dynamic segment is updated. `generateStaticParams` produces three pages.

### Redirects

`public/_redirects` gains:

```
/stablecoins/protocol/liquity-v1/* /stablecoins/infrastructure/liquity-v1/:splat 301
/stablecoins/protocol/liquity-v1   /stablecoins/infrastructure/liquity-v1   301
/stablecoins/protocol/liquity-v2/* /stablecoins/infrastructure/liquity-v2/:splat 301
/stablecoins/protocol/liquity-v2   /stablecoins/infrastructure/liquity-v2   301
/stablecoins/protocol/liquity/*    /stablecoins/infrastructure/liquity-v1/:splat 301
/stablecoins/protocol/liquity      /stablecoins/infrastructure/liquity-v1   301
```

The deleted `/protocol/liquity/` family page redirects to the v1 page (the older and more SEO-established of the two children) rather than 410-ing.

### Cross-page links

`src/components/stablecoin-detail/explore-next-section.tsx:59-70` builds protocol taxonomy links from the variant. Update to read from `meta.infrastructures` and call `buildInfrastructureTaxonomyUrl()`. If the array has multiple entries, link to the **first** one (rare case, easy to revisit later).

Search the codebase for any other references to the old `/stablecoins/protocol/` paths or `protocolFamily` / `protocolVariant` symbols and update or delete them.

## Methodology copy

### `src/app/methodology/scoring-changelog/content-v7-0.tsx`

The existing v6.92 entry at lines 107-130 documents the dedicated `liquity-v1` reserves adapter. That historical entry stays as-is — it documents a past change.

### New methodology section

A new methodology section (or changelog entry under the next version bump) explains the Infrastructure axis. Suggested content:

> **Infrastructure** identifies the shared technical foundation a stablecoin was built on. Currently three values: **Liquity v1**, **Liquity v2**, and **M0**.
>
> *Liquity v1* and *Liquity v2* are **code lineages** — coins that fork the original Liquity CDP implementation (v1) or its newer BOLD-style design (v2). Forks share source code but operate independently with their own reserves, governance, and stability pools.
>
> *M0* is an **issuance-platform lineage** — coins built on M0's smart-contract rails (minter governance, SwapFacility, the MExtension.sol contract pattern). M0 provides the issuance machinery; the reserve composition is set by the issuer and **may or may not include the underlying `$M` token**. Some M0-built coins are simple `$M` wrappers, others manage diversified collateral via M0's infrastructure.
>
> Pharos surfaces this tag to make shared-foundation risk visible: a vulnerability in the Liquity v1 codebase potentially affects all v1 forks, and a governance issue at the M0 protocol level potentially affects all M0-built coins, even if their day-to-day operations and reserves are independent.

This block lives wherever the existing protocol-family content currently lives in the methodology page.

### About page

`src/app/about/page.tsx` gains M0's GraphQL endpoint to the data sources list as a future-facing reference (the actual ingestion is out of scope for this change), and the existing "direct Liquity/B.Protocol reads" mention is left alone.

## Tests

Update or add the following:

- `src/hooks/__tests__/use-homepage-filters.test.ts` (line 11, 69-73): change the filter group key from `"Liquity Forks"` to `"Infrastructure"` and update the URL parsing test for the new query key.
- `src/components/stablecoin-detail/__tests__/hero-card.test.tsx` (lines 38-39): replace `protocolFamily: "liquity"` / `protocolVariant: "v2"` with `infrastructures: ["liquity-v2"]`. Add a second case asserting an `m0` infrastructure renders the M0 chip.
- `src/components/__tests__/stablecoin-table-logic.test.ts`: add cases for the new `infrastructure-m0` tag and updated `infrastructure-liquity-v1` / `infrastructure-liquity-v2` tags. Remove cases that referenced `liquity-family`.
- `shared/lib/__tests__/stablecoins.test.ts` (currently modified per `git status`): verify any references to the old fields are updated.
- New test in `shared/types/__tests__/` (or wherever `getFilterTags` tests live, possibly inline in `core.test.ts`) covering: empty `infrastructures`, single-element, multi-element, and the unset case.

## Files touched

- `shared/types/core.ts` — type definitions, `FilterTag` union, `FILTER_TAG_LABELS`, `getFilterTags()`
- `shared/lib/protocol-family.ts` → renamed to `shared/lib/infrastructure.ts`
- `shared/lib/__tests__/stablecoins.test.ts`
- `shared/data/stablecoins/usd-minor.json` — 13 Liquity migrations + 5 M0 additions
- `shared/data/stablecoins/usd-major.json` — 2 M0 additions (`usd0-usual`, `usdai-usd-ai`)
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/stablecoin-detail/__tests__/hero-card.test.tsx`
- `src/components/stablecoin-detail/explore-next-section.tsx`
- `src/components/filter-bar.tsx`
- `src/components/stablecoin-table-logic.ts` (verify only)
- `src/components/__tests__/stablecoin-table-logic.test.ts`
- `src/hooks/use-homepage-filters.ts`
- `src/hooks/__tests__/use-homepage-filters.test.ts`
- `src/lib/stablecoin-taxonomy.ts` — full rename of constants/helpers
- `src/app/stablecoins/protocol/[protocol]/` → renamed to `src/app/stablecoins/infrastructure/[infrastructure]/`
- `public/_redirects` — six new 301 lines
- `src/app/methodology/` — new Infrastructure section, inserted wherever the existing Liquity-fork content currently lives on the methodology page (the implementation step grep-finds the existing references and replaces in place)
- `src/app/about/page.tsx` — minor mention of M0 (optional)
- (consumer search) — any other files referencing `protocolFamily`, `protocolVariant`, `LiquityForkBadge`, or `/stablecoins/protocol/` are updated

## Out of scope

- Adding the 10 untracked M0 stablecoins (wrapped $M, USDhl, KAST USDK, Braid USDZ, Dfns 0fns, MANTRA mantraUSD, USD+ Streamflow, XO Cash, Agent USD AUSD, Meridian MrUSD, Nerona USDnr). The user has another agent on this. Note ticker collisions for: USDK, USDZ, AUSD, USAT/USDAT, USDN, USD+.
- Adding `m-m0` to the `dependencies[]` of `usdn-noble`, `musd-metamask`, `usd0-usual`, `usdai-usd-ai` — that belongs to the asset-graph layer and the contract-enrich/reserve-research pipeline, not this taxonomy change.
- Automated ingestion of the M0 extensions list from the M0 GraphQL subgraph (`https://protocol-api.m0.org/graphql`) or dashboard scrape. Deferred to a follow-up cron task.
- A multi-infrastructure aggregation page or "Infrastructure" landing page at `/stablecoins/infrastructure/` (no parent page; only the three sibling pages).

## Risks

- **Plural-cardinality dead code.** The array shape and the multi-chip rendering path are correct in principle but exercised by zero coins today. Risk that the renderer has a bug that only surfaces if a future coin sets `infrastructures: ["liquity-v2", "m0"]`. Mitigated by including a multi-element test case in `hero-card.test.tsx` even though no real coin needs it.
- **Methodology framing**. M0 is conceptually unlike a code fork. If the methodology copy oversimplifies, readers may assume an M0-tagged coin is collateralised by `$M`. The proposed copy is explicit about this; final wording needs a careful read.
- **SEO bleed during URL migration**. Three indexed paths under `/stablecoins/protocol/liquity*` will redirect to new locations. Search engines will reindex over weeks, not minutes. The 301s are correct and idempotent.
- **`bold-liquity` / `lusd-liquity` exclusion removal**. Today these reference implementations are explicitly excluded from the fork badge. After this change, they get tagged as `infrastructure-liquity-v2` / `infrastructure-liquity-v1`. This is intentional and matches the new label semantics ("Infrastructure: Liquity v1", not "Liquity Fork"), but it's a visible behaviour change on two detail pages — flag in the PR description.
- **Validation of Liquity migration**. The flat union assigns each existing coin exactly one infrastructure value. Confidence that all 13 currently-tagged coins have an unambiguous v1-or-v2 assignment is high (the old `protocolVariant` already encoded it), but the migration script should fail loudly if any coin's old variant value is something other than `"v1"` or `"v2"` (e.g., a `"style"` that the research missed).

## Verification

After implementation:

1. `npm run lint` — passes
2. `npm run build` — passes (Next.js static export builds the new infrastructure routes and redirects)
3. `npm test` — all test suites pass, including the updated and new infrastructure tests
4. `cd worker && npx tsc --noEmit` — passes (worker doesn't touch infrastructure tags but shares `core.ts`)
5. `npm run test:merge-gate` — passes
6. Manual: visit `/stablecoins/infrastructure/m0/` and verify the seven M0 coins appear; visit each detail page and verify the badge renders; click the legacy `/stablecoins/protocol/liquity-v1/` URL and verify the 301 redirect lands on the new path.
