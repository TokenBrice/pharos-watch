# DefiLlama Treasury Adapter Parseability

Date: 2026-03-30
Observed at: 2026-03-30T20:23:09Z

## Question

Estimate how much of DefiLlama's public treasury surface is usable as a Phase 1 seed list for onchain protocol treasury addresses.

## Sources checked

- `DefiLlama/defillama-server`
- `DefiLlama/DefiLlama-Adapters`

Specifically:

- protocol metadata under `defi/src/protocols/*.ts`
- treasury adapter files under `projects/treasury/*.js`
- helper logic in `projects/helper/treasury.js`

## Top-line counts

- Protocol metadata entries with a `treasury: "..."` pointer: `390`
- Unique referenced treasury adapter names: `385`
- Treasury adapter JS files present in `projects/treasury/`: `421`

## Referenced adapter split

Across the `385` unique treasury adapter names referenced by `defillama-server`:

- `295` are `treasuryExports(...)` adapters with no obvious per-file dynamic fetch/call logic
- `10` are `treasuryExports(...)` adapters with obvious dynamic logic in-file
- `40` are custom non-`treasuryExports` files that still look static-address-based
- `29` are harder custom files or dynamic/custom-derived treasury modules
- `11` referenced adapter names did not have a matching file in `projects/treasury/`

## Practical MVP estimate

Best current estimate for "parseable enough for a Phase 1 seed extractor":

- **Strong seed set:** about `335 / 385` referenced adapters (`295 + 40`)
- Coverage of referenced adapters: about `87%`

This is the set most likely to yield treasury wallet seeds with a conservative static extraction pass.

## Why this is workable

Most treasury adapters use DefiLlama's helper:

- `treasuryExports({ ... })`

Those adapters typically declare one or more of:

- `owners: [...]`
- `ownTokenOwners: [...]`
- per-chain address arrays
- literal token lists

That is enough for a seed-harvest pass without executing the adapter.

The shared helper also shows the intended structure clearly:

- `owners`
- `tokens`
- `ownTokens`
- optional per-chain config

## Important caveat

The simple/parseable bucket is still a **heuristic**, not a guarantee.

Two reasons:

1. Some `treasuryExports(...)` files can still trigger extra complexity through helper config like `isComplex` / `complexOwners`.
2. Some custom files contain static addresses but derive balances in ways that may not map cleanly to a plain treasury-wallet list.

I found `5` treasury adapters that look simple at first glance but opt into hidden complex-owner behavior via the treasury helper:

- `contango.js`
- `stakedao.js`
- `dhedge.js`
- `shapeshift.js`
- `sideshift-ai.js`

So the honest Phase 1 framing is:

- `~330` referenced adapters look good for static address harvesting
- `~40-50` need custom/manual review

## Referenced missing files

Referenced by protocol metadata but no matching treasury JS file was found:

- `beamable-network`
- `beradrome`
- `cerberusdao.js`
- `chaintools.js`
- `fantohm-dao.js`
- `friendtech33`
- `futarchy-amm`
- `jpegd`
- `merit-circle`
- `newland.js`
- `piku-dao`

These would need manual resolution or should be excluded from a first pass.

## Examples

### Clean static example

`projects/treasury/aave.js`

This file contains explicit treasury address arrays by chain and is an ideal seed source.

### Custom but still usable

`projects/treasury/benqi.js`

This file uses contract reads for treasury value, but still hardcodes treasury owner addresses. Good candidate for address extraction even if not for exact replay of DefiLlama balance logic.

### Not a good static-only candidate

`projects/treasury/bitdao.js`

This file depends on Mantle API data and wallet lists returned at runtime. It is not a clean static-wallet extractor target.

### Helper-induced complexity

`projects/treasury/contango.js` and peers with `isComplex` / `complexOwners`

These may pull portfolio data through helper-side Debank logic, so a static pass should avoid overclaiming completeness.

## Recommendation

Use DefiLlama's public GitHub treasury adapters as the **base list**.

Phase 1 approach:

1. Parse referenced treasury adapter files only
2. Extract literal owner wallet addresses conservatively
3. Keep chain prefixes when present
4. Mark each protocol with a coverage tier:
   - `static-seeded`
   - `custom-reviewed`
   - `dynamic/unresolved`
   - `missing`
5. Pair the extracted wallet set with Dune/Sim balance infrastructure

## Bottom line

This is materially better than starting from zero.

You do **not** get a perfect treasury dataset for free, but you likely get a usable public seed set for roughly **85-90%** of the referenced DefiLlama treasury adapter surface, which is enough to justify an MVP if the feature is framed as:

- onchain treasury stable exposure
- best-effort public-address coverage
- explicit coverage badges per protocol
