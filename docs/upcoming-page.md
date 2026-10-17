# Upcoming Page

Public `/upcoming/` is the pre-launch tracker, separate from active monitoring. `src/app/upcoming/page.tsx` owns metadata/static shell and projects the server registry into `src/components/upcoming-client.tsx`; `src/lib/pre-launch.ts` owns phase, fuzzy-date, drift and sorting semantics.

## Data Contract

Membership is checked-in `status: "pre-launch"` metadata via `PRE_LAUNCH_STABLECOINS`, not live API inference. Regenerate full/client projections with `npm run bootstrap:generated` after catalog changes. The route uses static logos and optional authored/generated teaser copy; no Worker request or new endpoint belongs here.

Keep full server metadata available for JSON-LD and crawlable profile links, but send clients only the card/filter projection. The shared Horizon constellation is also used on homepage; that teaser is not a second full tracker.

## Filter And Sort Model

Filtering starts from the full pre-launch projection before sorting. Shared URL codec owns phase/peg/backing comma-delimited multiselects and sort; default expected-launch order is omitted. Invalid state is normalized under the schema, not guessed from labels. Conditional controls depend on actual cohort diversity, not a hardcoded roster. Empty results retain a Clear filters action; exact empty copy lives in source.

## Deadline Contract

Year/month/quarter/half-year/day targets describe inclusive UTC periods and expire at the following midnight, not their sorting date. Drift depends on the current target, not revision history. `ExpectedLaunchDriftBadge` is a clock-aware client island that hydrates/updates at expiry without fetch; phase/milestone metadata remains server-renderable. Never interpret fuzzy dates as precise launch promises.

## Launch Alert Promotion

Preserve the copyable global `/subscribe launch all` command for `@PharosWatchBot`. Asset-specific exact commands belong on destination pre-launch detail pages and use canonical identity, not ticker guessing. [Stablecoin detail](./stablecoin-detail-page.md) owns those commands/landing contracts.

## SEO And Crawlability

Keep public indexability, canonical `/upcoming/`, route OG and sitemap membership. The static shell emits CollectionPage/ItemList JSON-LD and a crawlable nav to every pre-launch `/stablecoin/[id]/` profile, even when visible cards need hydration. Each card links through `buildStablecoinUrl`, never a separate invented upcoming profile URL.

## Update Rules

Membership/phase/deadline/filter changes update the registry/projection or `pre-launch.ts`, focused client tests and this owner; shared Horizon/homepage descriptions change together. Metadata/route/link changes include sitemap/crawlable nav and detail owner. Use the pre-launch review workflow for evidence refresh; no runtime activation is implied by editing expected dates.
