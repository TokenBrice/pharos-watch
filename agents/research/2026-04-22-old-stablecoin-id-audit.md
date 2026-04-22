# Old Stablecoin ID Audit

Date: 2026-04-22

## Scope

This audit treats the "old stablecoin ID system" as the legacy DefiLlama numeric stablecoin ID path that predated the current canonical Pharos `ticker-issuer` ID scheme.

Scope clarification after follow-up:

- keep `llamaId` where it is the active DefiLlama provider key
- target only app-facing legacy stablecoin IDs and compatibility aliases that behave like old Pharos IDs
- examples: numeric detail-route IDs, `cg-*` route aliases, old symbol/url tokens, and defunct-only numeric IDs if they are still emitted as report-card IDs

Included:

- `llamaId` fields in tracked/shadow/dead stablecoin metadata
- runtime code that maps DefiLlama numeric IDs to canonical IDs
- compatibility paths that still accept or redirect old IDs
- historical/admin scripts that still fetch or canonicalize by `llamaId`
- obvious data artifacts still keyed by numeric IDs

Excluded:

- unrelated uses of the word `legacy`
- non-stablecoin DefiLlama protocol IDs
- docs-only mentions unless they were needed to interpret code behavior

## High-level answer

The repo is only partially on the new system:

- The worker/API canonical resolver is already migrated. Public API resolution only accepts canonical `ticker-issuer` IDs.
- The DefiLlama integration is not migrated. `llamaId` is still the active external key for most DefiLlama-backed assets.
- Some frontend compatibility remains on purpose. Old numeric IDs still decode in compare/portfolio/stress URL flows, and old stablecoin detail URLs still redirect.
- There is also some low-value residue that looks removable without changing behavior, notably numeric-key logo artifacts.

So the old system is **not fully safe to retire wholesale**. The public/internal ID scheme is retired; the DefiLlama-external-key scheme is not.

Under the narrower scope above, the practical cleanup target is much smaller:

- detail-route redirects generated from old IDs
- frontend URL/token decoding of old IDs
- one historical repair alias map for old `cg-*` IDs
- optional defunct-only outputs that still emit numeric IDs as report-card/cemetery keys

## Counts

### Metadata counts

- Tracked active assets with `llamaId`: `144 / 215`
  - `usd-major.json`: `28 / 36`
  - `usd-minor.json`: `87 / 118`
  - `non-usd.json`: `29 / 41`
  - `commodity.json`: `0 / 9`
  - `pre-launch.json`: `0 / 11`
- Shadow assets with `llamaId`: `1 / 2`
- Dead stablecoins with `llamaId`: `27 / 88`

Net: `145` live/shadow assets still carry a DefiLlama numeric identifier.

### Code hit counts

Broad non-data/non-doc/non-test grep for `llamaId`, `REGISTRY_BY_LLAMA_ID`, `resolveByExternalId`, `getLlamaId`, `DEAD_BY_LLAMA_ID`, and `stablecoin-id-registry` returned:

- `117` hits across `29` non-test files

This is concentrated in a few buckets:

- `47` hits in [scripts/generate-redirects.ts](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/generate-redirects.ts:1)
- `18` hits in [shared/lib/stablecoin-id-registry.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoin-id-registry.ts:1)
- `8` hits in [worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts:1)

### Redirect counts

From [scripts/generate-redirects.ts](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/generate-redirects.ts:1):

- total redirect mappings emitted: `172`
- numeric old IDs among those mappings: `152`
- `cg-*` old IDs among those mappings: `12`
- other non-numeric legacy IDs: `8`

Those mappings generate `344` redirect lines in `public/_redirects`.

### Residue counts

- [data/logos.json](/home/ahirice/Documents/git/stablecoin-dashboard/data/logos.json:1) has `330` keys
- canonical keys present in the logo file: `215`
- numeric keys still present: `74`
- numeric keys that appear unused by canonical UI lookups: `74`

## Where the old IDs still exist

## 1. Core runtime DefiLlama integration

These are active runtime dependencies, not just compatibility leftovers.

- [shared/lib/stablecoin-id-registry.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoin-id-registry.ts:6)
  - builds `REGISTRY_BY_LLAMA_ID`
  - exposes `resolveByExternalId("defillama", ...)`
  - stores `DEAD_BY_LLAMA_ID`
- [scripts/check-stablecoin-data.ts](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/check-stablecoin-data.ts:42)
  - treats `llamaId` as a valid `/api/stablecoins` cache-admission path
- [worker/src/cron/sync-stablecoins/intake.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/intake.ts:211)
  - filters tracked DefiLlama assets by `REGISTRY_BY_LLAMA_ID`
  - remaps upstream numeric `asset.id` to canonical `ticker-issuer` IDs before publishing cache payloads
- [worker/src/api/stablecoin-detail/router.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stablecoin-detail/router.ts:55)
  - routes DefiLlama detail fetches with `llamaId`
- [worker/src/api/stablecoin-detail/defillama.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stablecoin-detail/defillama.ts:157)
  - calls `GET /stablecoin/{llamaId}`
- [worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts:197)
  - fetches DefiLlama chart history by `llamaId`
- [src/app/stablecoin/[id]/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/stablecoin/[id]/page.tsx:116)
  - publishes DefiLlama sameAs links with `coin.llamaId`

Assessment: **not safe to retire** unless the DefiLlama-backed runtime is redesigned.

## 2. Canonical resolver already migrated

- [shared/lib/stablecoin-id-registry.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoin-id-registry.ts:76)
  - `resolveStablecoinId()` only accepts canonical IDs
- [worker/src/lib/api-params.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/api-params.ts:29)
  - API param parsing relies on `resolveStablecoinId()`
- [worker/src/api/feedback/request.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/feedback/request.ts:45)
  - feedback payload stablecoin IDs are canonicalized through the same resolver
- [shared/lib/__tests__/stablecoin-id-registry.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/stablecoin-id-registry.test.ts:63)
  - explicitly asserts that legacy numeric IDs are no longer accepted by the canonical resolver

Assessment: **already retired** on the worker/API identity surface.

## 3. Frontend compatibility layer

These are not required for canonical runtime operation, but they still preserve old links and query params.

- [scripts/generate-redirects.ts](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/generate-redirects.ts:260)
  - generates redirects from old numeric IDs to canonical detail routes
- [public/_redirects](/home/ahirice/Documents/git/stablecoin-dashboard/public/_redirects:19)
  - currently serves those redirects
- [src/lib/stablecoin-url-codec.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/stablecoin-url-codec.ts:24)
  - still decodes numeric `llamaId` tokens to canonical IDs
- [src/lib/compare-config.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/compare-config.ts:75)
  - compare URL params use that decoder
- [src/hooks/use-stress-test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-stress-test.ts:110)
  - stress-test URL params use that decoder
- [src/lib/portfolio-codec.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/portfolio-codec.ts:19)
  - portfolio holdings still normalize numeric IDs
- [src/lib/__tests__/stablecoin-url-codec.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/__tests__/stablecoin-url-codec.test.ts:11)
  - explicitly tests `decodeStablecoinUrlToken("1") === "usdt-tether"`

Assessment: **conditionally safe to retire**, but only after deciding whether old shared URLs still matter.

## 4. Historical/dead-asset and admin repair paths

These are not hot-path runtime identity resolution, but they still depend on numeric IDs for historical correctness or export stability.

- [worker/src/api/backfill-depegs.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-depegs.ts:195)
  - fetches detail by `meta.llamaId ?? meta.id`
- [worker/src/api/backfill-supply-history.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-supply-history.ts:291)
  - same pattern for historical supply backfill
- [worker/scripts/repair-non-usd-fiat-depeg-history.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/scripts/repair-non-usd-fiat-depeg-history.ts:259)
  - same pattern for repair tooling
- [worker/src/lib/report-cards-snapshot-finalize.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot-finalize.ts:28)
  - dead stablecoins still use `dead.llamaId` as report-card ID when present
- [worker/src/lib/telegram-digest-appendices.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/telegram-digest-appendices.ts:66)
  - cemetery snapshot keys prefer `llama:{llamaId}`
- [scripts/generate-cemetery-dataset.ts](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/generate-cemetery-dataset.ts:79)
  - exports dead `llamaId` into the public cemetery dataset

Assessment: **not safe to retire quickly** unless the historical/dead-asset identifier story is redesigned too.

## 5. Discovery/admin telemetry and likely residue

- [worker/src/cron/discovery-scan.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/discovery-scan.ts:55)
  - stores candidate `llamaId` values for untracked stablecoins
- [worker/src/lib/discovery-candidates.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/discovery-candidates.ts:37)
  - maps `llama_id` DB column into the status type
- [shared/types/status.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/status.ts:316)
  - status payload includes numeric `llamaId` for discovery candidates
- [scripts/fetch-logos.ts](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/fetch-logos.ts:31)
  - still builds logo output keyed by DefiLlama numeric IDs
- [data/logos.json](/home/ahirice/Documents/git/stablecoin-dashboard/data/logos.json:1)
  - still contains `74` numeric keys that do not appear to be used by canonical UI lookups

Assessment:

- discovery telemetry use is legitimate if discovery still wants the DefiLlama external key
- numeric-key logo artifacts look like **good cleanup candidates**

## Safety to retire

## Safe right now

- Treating numeric DefiLlama IDs as canonical public API IDs
- Worker/API acceptance of numeric IDs through `resolveStablecoinId()`

That part is already done.

## Not safe right now

- deleting `llamaId` from active tracked metadata
- removing `REGISTRY_BY_LLAMA_ID`
- removing DefiLlama numeric remapping from stablecoin intake
- removing `llamaId` fetches from detail/history/backfill/admin repair paths

Those changes would break core supply/detail/history behavior for most tracked assets.

## Probably safe after validation

- numeric-ID URL decoding in compare/portfolio/stress flows
- old stablecoin detail redirects
- unused numeric keys in `data/logos.json`
- numeric-key output generation in `scripts/fetch-logos.ts`

These are compatibility/data-hygiene candidates, not core source-of-truth dependencies.

## Notable risk points

### 1. Core sync breakage

`sync-stablecoins` currently relies on numeric DefiLlama IDs to match upstream rows back to tracked Pharos assets. Removing that mapping without a replacement would leave upstream numeric IDs uncanonicalized, which would poison downstream cache consumers.

### 2. Historical/backfill breakage

Admin repair and backfill scripts still fetch DefiLlama detail/history by `llamaId`. Removing this without a replacement would break replay and repair tooling.

### 3. Old-link breakage

Compare, stress, portfolio, and detail-route compatibility still translate old IDs. Retiring these paths will break bookmarked/shared URLs unless there is traffic evidence that they are no longer used.

### 4. Dead/live identity overlap

There is at least one live/dead `llamaId` overlap:

- `llamaId "3"`: dead `UST TerraUSD` entry overlaps live shadow asset `ust-terra`

That overlap is manageable today because the contexts are separated, but it is exactly the kind of thing that can regress if the cleanup tries to collapse historical and live identity logic too aggressively.

### 5. Hidden downstream consumers

The public cemetery dataset exports `llamaId`, and some internal snapshotting logic still prefers it. Removing the field is not just a local refactor; it changes exported data and snapshot identity.

## Cleanup plan

## Recommended scope boundary

Do **not** frame this as "remove `llamaId` everywhere." The safer framing is:

1. remove legacy-ID compatibility where it no longer buys us anything
2. keep `llamaId` where it is still the active DefiLlama integration key
3. separately decide later whether the DefiLlama integration itself should be redesigned

## Phase 1: separate compatibility from integration

- keep `llamaId` in stablecoin metadata, registry, intake, detail, and historical tooling
- explicitly document that `llamaId` is now an external-provider key, not a canonical stablecoin ID
- audit remaining uses and label them as either `integration`, `compatibility`, `historical`, or `residue`

Success criteria:

- every remaining `llamaId` reference has a clear reason to exist
- no one confuses `llamaId` with the canonical public ID anymore

## Phase 2: retire low-value residue

- change [scripts/fetch-logos.ts](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/fetch-logos.ts:31) to emit canonical Pharos IDs as keys
- migrate or regenerate `data/logos.json` so numeric keys disappear
- remove any dead code/comments that imply numeric IDs are still first-class internal IDs

Success criteria:

- `data/logos.json` is keyed only by canonical IDs
- no UI code depends on numeric logo keys

Risk: low.

## Phase 3: remove URL-level compatibility after evidence

- instrument or inspect traffic for:
  - old `/stablecoin/<numeric>` redirects
  - compare params decoded from numeric IDs
  - stress params decoded from numeric IDs
  - portfolio payloads/URL params containing numeric IDs
- if usage is effectively zero for a sustained window, remove:
  - numeric decode branch in [src/lib/stablecoin-url-codec.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/stablecoin-url-codec.ts:24)
  - dependent compatibility behavior in compare/stress/portfolio flows
  - optionally the generated redirect table

Success criteria:

- all supported user-facing links serialize and deserialize canonical IDs only
- no meaningful legacy traffic is still arriving

Risk: medium, user-facing.

## Phase 4: decide whether DefiLlama-key cleanup is worth it

If the goal is to fully remove DefiLlama numeric IDs from tracked metadata, that becomes a bigger architecture change:

- introduce a different stable external lookup key for DefiLlama-backed assets, or
- stop relying on DefiLlama stablecoin endpoints that require numeric IDs, or
- build and maintain a separate translation table outside stablecoin metadata

That is a separate project, not a quick cleanup.

Success criteria:

- core intake/detail/history behavior remains correct for all DefiLlama-backed assets
- backfill/admin repair flows still work

Risk: high.

## Recommendation

Recommended near-term action:

- retire residue and compatibility, not `llamaId` itself

In practice:

1. clean up numeric-key logo artifacts first
2. gather evidence on old redirect/query-param traffic
3. remove numeric URL decoding and redirects only if real usage is negligible
4. leave the DefiLlama integration key path alone unless there is appetite for a larger provider-integration redesign

## Bottom line

- Old numeric IDs are already retired as canonical/public API IDs.
- They are not retired as DefiLlama external keys.
- Full removal today would be risky.
- A partial cleanup focused on redirects, URL decoding, and numeric-key residue is realistic and low-to-medium risk.
