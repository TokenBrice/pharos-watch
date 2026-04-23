## Alt-Pegs Fiat Cohort Map Review

### Scope

Review the current `Explore Peg Cohorts` screenshot and propose an implementable world-map-based alternative for the fiat cohort portion that remains consistent with Pharos' dense dark analytics UI.

### Constraints

- The current route is a non-USD market-structure surface, not a generic geographic dashboard.
- The available model supports peg cohorts and a curated region mapping, not country-level adoption, issuance, or reserve distribution.
- The static link hub exists partly for crawlability and direct drill-down into `/stablecoins/[peg]/`.
- Commodity cohorts, especially gold, are materially important but are not naturally geographic in the same sense as fiat pegs.

### Recommendation

Use a **reference-geography world map with regional overlays and hub labels** for the fiat section.

- Render a subdued, low-detail world basemap as context only.
- Shade broad regions instead of countries.
- Place one labeled hub per fiat cohort near its reference geography.
- Use short leader lines only where necessary to keep labels readable.
- Preserve direct drill-down behavior from every hub label.

### Gold Handling

Do **not** force gold into the geographic map itself.

Instead, add an **off-map commodity inset** in the same card:

- a compact "bullion lane" or "commodity reserve" strip in the upper-right
- gold as the dominant weighted node
- silver as the secondary node
- same chip styling and direct links as fiat hubs

This keeps gold visible without falsely implying a geographic origin or overwhelming the world view.

### Why This Beats Other Map Styles

- **Not choropleth**: the data is not country-level magnitude, so a choropleth would overstate geographic precision and invite false comparisons.
- **Not pure small multiples**: too list-like; it loses the one thing a map can add here, which is global orientation.
- **Not labels-only without overlays**: dense labels alone will feel like a scatterplot of chips rather than an authored map.
- **Best fit**: region overlays + hub labels, with commodity handled as an intentional off-map inset.

### Key Interaction Rules

- Hover/focus a region: brighten the overlay and emphasize the cohorts anchored there.
- Hover/focus a cohort hub: highlight its label, tint the relevant region, dim unrelated hubs.
- Click: route directly to the cohort page.
- Keep the current chip semantics: color dot, label, coin count, symbol preview.
- Mobile: collapse to region-first stacked panels with a mini-map preview rather than trying to preserve desktop label density.

### Main Failure Modes

- Over-precision: using country fills or exact centroids suggests data the product does not actually have.
- Commodity distortion: putting gold on the map will dominate visually and mislead conceptually.
- Label collisions in Europe/Asia: too many hubs in dense areas will collapse readability.
- Decorative map syndrome: if the map becomes too quiet, it adds atmosphere but not scan value.
- Accessibility loss: relying on hue alone will make cohorts harder to differentiate under dense dark styling.
