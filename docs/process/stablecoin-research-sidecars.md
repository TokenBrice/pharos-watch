# Stablecoin Research Sidecars

Research-heavy metadata can move independently from a coin's scalar identity and routing metadata. Sidecars reduce conflict pressure without changing the merged `StablecoinMeta` contract or any generated projection.

## Domain Ownership

| Domain         | Sidecar path                                               | Owned fields                                                                  |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Reserves       | `shared/data/stablecoins/domains/reserves/<id>.json`       | `reserves`, `reserveReview`                                                   |
| Mint authority | `shared/data/stablecoins/domains/mint-authority/<id>.json` | `mintAuthority`                                                               |
| Compliance     | `shared/data/stablecoins/domains/compliance/<id>.json`     | `mica`, `genius`                                                              |
| Risk review    | `shared/data/stablecoins/domains/risk-review/<id>.json`    | `canBeBlacklisted`, `blacklistabilityReview`, `oracleRisk`, `bridgeRouteRisk` |

Sidecars are selective. Fields such as identity, flags, contracts, links, jurisdiction, classification overrides, notices, launch metadata, and other scalar catalog metadata remain in `coins/<id>.json`.

`reserveReview` records the human review of a reserve composition: review date and reviewer, confidence, sources, composition basis and optional as-of date, reviewed scope, known-unknown exposure, and fingerprinted dispositions for selected unlinked slices. A disposition stores the current reserve index and exact name, so changing or reordering a reviewed slice makes validation fail until the review is revisited. Candidate IDs are research leads only; they do not create dependency edges. The reserves sidecar may contain `reserveReview`, `reserves`, or both, but a merged coin may only carry a review when it also has reserve composition.

`dependencyReview` remains base metadata. It is required only for authored `dependencies` relationships that are not already represented by a linked reserve slice. Its relationship list must exactly match those manual-only edges, including an explicit dependency type. Reserve-derived dependencies use the reserve composition and `reserveReview` provenance instead of duplicating evidence per edge.

Once a coin has a sidecar for a domain, all fields owned by that domain must stay out of its base file. This keeps the evidence and its coupled decision fields together. In particular, an explicit `canBeBlacklisted` value moves with `blacklistabilityReview`.

Research review envelopes remain server/repository evidence and are intentionally omitted from `coins.client.generated.json`. The full generated registry retains them for audits and report-card compilation.

## Updating Research

1. Check whether `domains/<domain>/<id>.json` exists.
2. If it exists, edit the sidecar. Do not copy its fields back into `coins/<id>.json`.
3. If it does not exist, keep a narrow one-off update in the base file or deliberately migrate the whole domain with the workflow below.
4. Preserve existing evidence and values unless the task includes reviewed research. A layout migration must not invent or refresh facts.
5. Run focused schema/loader tests before regenerating artifacts.

Sidecars use strict schemas. Unknown keys, a sidecar ID that differs from its filename/base ID, orphan sidecars, unsupported domain directories, and any base/sidecar domain split are errors.

## Migration Workflow

Preview a move:

```bash
npx tsx scripts/maintenance/migrate-stablecoin-sidecar.ts \
  --domain compliance \
  --id usdc-circle \
  --dry-run
```

Apply one domain to one or more coins:

```bash
npx tsx scripts/maintenance/migrate-stablecoin-sidecar.ts \
  --domain risk-review \
  --id coin-a \
  --id coin-b
```

Verify that requested profiles are already migrated:

```bash
npx tsx scripts/maintenance/migrate-stablecoin-sidecar.ts \
  --domain mint-authority \
  --id coin-a \
  --check
```

The tool moves only already-authored fields, validates the strict sidecar and base shapes, rebuilds the merged coin in memory, and refuses to write unless that projection is deeply equal to the original. It also refuses partial migrations when a target sidecar already exists while owned fields remain in the base file.

## Coordinated Generation

In parallel work, finish all base/sidecar moves before regenerating shared projections. Record hashes or retain an in-memory snapshot of the generated projections before a layout-only batch, then regenerate once:

```bash
npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
node scripts/build-data/build-client-registry.mjs
node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs
node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs
```

For a layout-only move, the full, client, compliance, prevalidated, and legacy-redirect artifacts must remain byte-identical. If they change, stop and inspect the projection before proceeding.

Validation:

```bash
npm run check:stablecoin-data
npm run check:generated-artifacts
npm run check:doc-counts
npm run typecheck
npm run typecheck:worker
```
