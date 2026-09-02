# Stablecoin Data Agent Notes

Applies to `shared/data/stablecoins/`.

## Read First

- `docs/stablecoin-data.md` § “Source Files” is the sole generated-output inventory and wins over local summaries.
- `docs/process/stablecoin-research-sidecars.md` § “Domain Ownership” owns sidecar semantics and migrations.
- `docs/process/adding-a-stablecoin.md` § “Guardrails” owns listing decisions, runtime admission, logos, summaries, and checked-in artifact coupling.
- `docs/classification.md`; `docs/shadow-stablecoins.md` for PSI-only exclusions.

## Rules

- Edit base metadata in `shared/data/stablecoins/coins/`; edit research-domain fields only in `shared/data/stablecoins/domains/`. Never duplicate a domain-owned field in the base file or split coupled fields across both sources.
- `shared/lib/stablecoins/schema.ts` defines domain field ownership. Sidecar IDs must match base coin IDs, and sidecars never live under `shared/data/stablecoins/coins/`.
- Never hand-edit generated outputs. After source edits, follow `docs/stablecoin-data.md` § “Editing Rules”; its output inventory is authoritative.
- Author only non-default flags: omit `pegCurrency: "USD"`, `yieldBearing: false`, `rwa: false`, and `navToken: false`; `backing` and `governance` remain required. `npm run check:stablecoin-data` enforces omission.
- Keep `shared/data/stablecoins/canonical-order.json` aligned with the catalog, and add contracts only after source verification.
- Keep relationships that reserve composition can express out of manual `dependencies`; manual-only relationships require sourced `dependencyReview`.

## Common Checks

- `npm run check:stablecoin-data` and `npm run check:generated-artifacts`.
- Focused registry and shared tests live under both `shared/lib/stablecoins/__tests__/` and `shared/lib/__tests__/`.
