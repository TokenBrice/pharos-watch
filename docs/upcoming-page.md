# Upcoming Page

Public `/upcoming/` is the pre-launch tracker, separate from active monitoring. `src/app/upcoming/page.tsx` owns metadata/static shell (title `Upcoming Stablecoin Launches ({Mon YYYY}): {N} Tracked` with the UTC build month and the upcoming count; description from the per-phase tally of `UPCOMING_LAUNCH_PHASE_VALUES` with `LAUNCH_PHASE_LABELS`) and projects the server registry into `src/components/upcoming-client.tsx`; `src/lib/pre-launch.ts` owns phase, fuzzy-date, drift and sorting semantics.

## Data Contract

Membership is checked-in `status: "pre-launch"` metadata via `PRE_LAUNCH_STABLECOINS`, not live API inference. The page splits it with `isLaunchedAwaitingData()`: rows with `launchPhase: "launched"` are live coins awaiting admissible data, so they never enter the upcoming count, the client projection, the Horizon constellation or the currency groups. Regenerate full/client projections with `npm run bootstrap:generated` after catalog changes. The route uses static logos and optional authored/generated teaser copy; no Worker data request or new endpoint belongs here (the Share image is the only API call, on demand).

Keep full server metadata available for JSON-LD and crawlable profile links, but send clients only the card/filter projection. The shared Horizon constellation is also used on homepage; that teaser is not a second full tracker.

## Page Shape

Instrument header (one-line deck, folded usage note, Alerts then Share), then one stacked `FeatureHeroSplit`: the tracked count as the beam with the `preLaunch` universe chip, three facts (soonest open target, Slipped with its pushed/overdue split, no target date), and the Horizon constellation beneath. The `/upcoming/` constellation adds an Unphased cell for coins without `launchPhase`, so its cells sum to the beam; the homepage teaser keeps the five phase cells. Below the hero, one `DataTableShell` carries a hairline filter toolbar and the listing; "How targets and drift are read" folds after it. Two server-rendered sections follow (`src/lib/upcoming-static-content.ts`, `src/components/upcoming-static-sections.tsx`): "Latest launch news", the 10 newest registry milestones across pre-launch coins ("{date} · {SYM}: {title}", each linking the profile, dated at the milestone's recorded precision), and per-currency h2 groups ("Upcoming Hong Kong Dollar (HKD) stablecoins", set in the same `.pharos-label` register as the news heading, largest group first, other pegs last) linking every upcoming profile plus the peg hub where one exists. Neither reads a clock. The table section is headed "Upcoming (N)". When any row is `launched`, a server-rendered "Launched – not yet tracked (M)" section (`UpcomingLaunchedSection`, rows from `buildLaunchedUntrackedRows`) sits between the table and the news: each row links the profile and shows the phase badge, "Live since {launchDate}", the review's missing-lane reason and its review date, newest launch first. The breadcrumb stays "Upcoming Stablecoins".

## Filter And Sort Model

Filtering starts from the full pre-launch projection before sorting. Shared URL codec owns phase/peg/backing comma-delimited multiselects plus `sort` and `dir`; the default (expected launch, ascending) is omitted. Phase values include `unphased`. Sorting is by column header (coin, phase, peg, backing, expected, drift, milestones); a first click uses the column's reading direction (dates and names ascending, phase/drift/milestones descending), a second flips it. Coins without a target always sort last, ties fall back to target then name. Invalid state, including retired sort values, is normalized under the schema, not guessed from labels. Toolbar: phase and backing pills with cohort counts, peg in a checkbox menu, inline Clear and result count; below `sm` it folds behind a "Filters (n)" button. Conditional controls depend on actual cohort diversity, not a hardcoded roster. Empty results retain a Clear filters action; exact empty copy lives in source. Teasers, governance and announcement date sit in the row expansion; missing targets render "—".

## Deadline Contract

Year/month/quarter/half-year/day targets describe inclusive UTC periods and expire at the following midnight, not their sorting date. Drift depends on the current target, not revision history. The tracker reads the visitor clock after mount through `selectPreLaunchClockView` (`src/lib/pre-launch.ts`): it feeds Slipped (coins with a current target that was pushed once, delayed or is overdue; a coin whose earlier target was retired with none set resolves through `resolveDriftDisplay` to a neutral "No current target", carries no ring and is not counted), the soonest open target (overdue targets never qualify), the drift column and the constellation rings (amber = target pushed, red = overdue; coins folded into a "+N" marker are tallied on it, so rings plus tallies equal Slipped), and re-reads at the next target expiry without fetch. Detail readiness and launch path share one hydration-safe visitor-clock snapshot (`usePreLaunchNowMs` in `src/components/pre-launch-readiness.tsx`), refreshed at each UTC midnight and when a hidden tab becomes visible. Those daily boundaries cover every target expiry and announcement-age increment, even after all targets expire; no far-future target timeout or API request is needed. Server and first-hydration clock readings stay null. Phase/milestone metadata remains server-renderable. Never interpret fuzzy dates as precise launch promises.

## Launch Follow Action

Per-user launch alerts are retired. The header action is `Follow @pharoswatch` (`PreLaunchAlertAction`), an external link to the Telegram channel whose digest lists the stablecoins Pharos starts tracking. No body callout. Pre-launch detail pages carry the same action; [Stablecoin detail](./stablecoin-detail-page.md) owns that contract.

## Share Card

Share is timeless by decision ([OG images](./og-images.md)): the header `ShareButton` requests `/api/og/page/upcoming`, which serves the figure-free `upcoming` route card; route metadata keeps the static `og-upcoming.png`.

## SEO And Crawlability

Keep public indexability, canonical `/upcoming/`, route OG and sitemap membership. The static shell emits CollectionPage/ItemList JSON-LD, and the visible per-currency groups plus the launched section link every pre-launch `/stablecoin/[id]/` profile, even when table rows need hydration. Pre-launch profile `lastmod` is the coin file's commit date (milestones are committed there), so a new milestone moves it; a future-dated milestone never becomes a future `lastmod`. Each row links through `buildStablecoinUrl`, never a separate invented upcoming profile URL. Individual profile links on this page disable Next route prefetch so unvisited profiles do not download their Tweet media.

## Update Rules

Membership/phase/deadline/filter changes update the registry/projection or `pre-launch.ts`, focused client tests and this owner; shared Horizon/homepage descriptions change together. Metadata/route/link changes include sitemap/crawlable nav and detail owner. Use the pre-launch review workflow for evidence refresh; no runtime activation is implied by editing expected dates.
