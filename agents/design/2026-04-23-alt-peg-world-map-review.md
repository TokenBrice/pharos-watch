Date: 2026-04-23

# Alt-Peg World Map Review

## Scope

Review the `Explore Peg Cohorts` surface and assess how a world-map treatment could coexist with non-geographic cohorts (`Gold`, `Silver`, `CPI`) without misleading users or letting commodity pegs dominate the composition.

## Repo-grounded context

- Current surface: `src/app/alt-pegs/static-link-hub.tsx`
- Taxonomy source: `src/lib/alt-peg-market.ts`
- Existing grouping model already separates:
  - `Fiat`
  - `Commodity`
  - `Other`
- Current link-hub counts visible in the product concept and screenshot:
  - Fiat cohorts are region-grouped
  - Commodity cohorts are mainly `Gold` and `Silver`
  - `CPI` sits under `Other`
- Current page copy in `src/app/alt-pegs/client.tsx` already states that commodities dominate the broader alt-peg segment.

## Key problem

A naive world map fails because `Gold`, `Silver`, and `CPI` are not geographic pegs in the same way that `EUR`, `JPY`, or `BRL` are:

1. Gold and silver are reference assets, not country currencies.
2. A map implies territorial meaning: issuance jurisdiction, user demand, reserves location, or monetary area.
3. Pharos' current taxonomy does not encode a truthful one-country answer for commodity cohorts.
4. If gold is rendered as a large overlay, it visually overclaims the map because its market cap is large while its geography is conceptually weak.

## Truthful representation options

### 1. Off-map reference shelf

Use the world map only for fiat cohorts. Place `Gold`, `Silver`, and `CPI` in a compact parallel module docked to the right or below the map with the label `Non-geographic references`.

Why it works:

- Preserves the meaning of the map
- Keeps commodity scale visible without territorial distortion
- Matches the existing `Fiat / Commodity / Other` taxonomy already used in the code

### 2. Split encoding: map for fiat, orbital ring for reference pegs

Keep fiat cohorts on the map. Surround or flank the map with a thin “reference orbit” made of three weighted pills or arcs: `Gold`, `Silver`, `CPI`.

Why it works:

- Communicates that these cohorts belong to the same market surface but a different reference system
- Makes gold prominent without letting it swallow the atlas
- Feels authored rather than like another card stack, while staying honest

Risk:

- Needs restraint; too much ornament would drift away from Pharos’ dense dashboard language

### 3. Dual-frame toggle with persistent summary

Offer a top-level toggle:

- `Fiat world map`
- `Reference pegs`

Keep a persistent top summary bar showing all three buckets: `Fiat`, `Commodity`, `Other`.

Why it works:

- Avoids mixed semantics inside one visual
- Gives commodity pegs their own proper explanatory frame
- Prevents gold from visually dominating the fiat scan path

Risk:

- Slightly slower to scan than showing both at once
- Better for a larger module than for a compact link hub

## Recommended product pattern

Best fit for this surface:

### Use a fiat-only world map plus an off-map reference sidebar

Structure:

- Main visual: `Fiat world map`
  - Encode fiat cohorts only
  - Group by monetary area or peg region, not by issuer country count unless that data is explicit
  - Keep labels sparse and drive clicks into cohort chips/list items
- Sidecar rail: `Non-geographic references`
  - `Gold`
  - `Silver`
  - `CPI`
  - Show coin count and market-share cue
  - Add a short explainer like `Tracked off-map because these cohorts reference assets or indices, not monetary regions.`

Why this is the best fit:

- It keeps the map semantically clean
- It preserves current taxonomy truth
- It avoids rewarding gold with the biggest visual object just because it is large
- It fits the existing Pharos card shell and dense information style better than a more illustrative concept

## Implementation notes

- Do not label the module as a generic `world map of alt-pegs`; label it as `Fiat peg geography` or equivalent.
- Do not drop `Gold` onto producing countries or vault jurisdictions unless Pharos adds explicit data for that concept.
- If size encoding is used on the map, use it only within the fiat frame; commodity size belongs in the off-map rail.
- Let the sidecar use the same cohort dot colors already sourced from classification metadata rather than inventing a second legend.
- If space is tight on smaller breakpoints, collapse the world map into region chips and keep the off-map reference shelf as a simple stacked list.
