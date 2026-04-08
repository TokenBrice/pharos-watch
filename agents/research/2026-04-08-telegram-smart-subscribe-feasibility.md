# Telegram Smart Subscribe Feasibility

Date: 2026-04-08

## Request

Feature request for the Telegram bot:

- market cap above `> X`
- peg-type top `10` / `25` / `50`
- example: `USD top 25`

There is margin to interpret this as either:

1. true dynamic "smart lists" whose membership changes over time
2. curated/default preset lists that expand to concrete coin subscriptions

## Current architecture

### What exists now

- The webhook only supports two subscription scopes today:
  - explicit per-coin rows in `telegram_subscriptions`
  - global all-stablecoin flags in `telegram_subscribers`
- `/subscribe` currently parses only alert types plus explicit tickers or `all`.
- Dispatch is optimized for explicit coin IDs:
  - it detects alert events first
  - then loads per-coin subscribers for the changed IDs
  - then overlays global all-stablecoin subscribers
  - then routes everything in memory

### Why this matters

The current design is a strong fit for:

- explicit coin subscriptions
- a single global `all`

It is not yet shaped around reusable cohorts like:

- `usd-top25`
- `mcap-ge-100m`
- `gold-top5`

That means the main product choice is whether we want:

- preset expansion at subscribe time
- or a new first-class cohort/smart-subscription primitive

## Data feasibility

### Data needed for smart lists already exists

We already have enough data to compute these lists without adding a new upstream:

- peg type / peg currency is in tracked metadata (`flags.pegCurrency`)
- current market cap is available from the stablecoins cache via `circulating`
- historical market cap is available in `supply_history`

Repo gotcha still applies:

- DefiLlama list-endpoint `circulating` values are already USD-denominated
- do not multiply supply by price again

### Active tracked-coin distribution by peg

From the checked-in metadata set:

- `USD`: 129 active coins
- `EUR`: 13 active coins
- `GOLD`: 8 active coins
- everything else: 3 or fewer each

This matches the request intuition: top-N lists only really make sense for `USD`, `EUR`, and `GOLD`.

### Current market-cap cohorts from remote D1

Read-only query against the latest `supply_history` snapshot shows:

- all pegs combined:
  - `>= $10B`: 2
  - `>= $5B`: 4
  - `>= $1B`: 17
  - `>= $100M`: 60
  - `>= $50M`: 77
  - `>= $10M`: 130
- USD:
  - total: 129
  - `>= $1B`: 15
  - `>= $100M`: 52
  - `>= $50M`: 65
  - `>= $10M`: 107
- EUR:
  - total: 13
  - `>= $100M`: 2
  - `>= $50M`: 3
  - `>= $10M`: 6
- GOLD:
  - total: 8
  - `>= $1B`: 2
  - `>= $100M`: 3
  - `>= $50M`: 5
  - `>= $10M`: 6

Implication:

- `USD top 10/25/50` is sensible
- `EUR top 10` is sensible; `EUR top 25` is not
- `GOLD top 5` or `GOLD all` is sensible; `GOLD top 25` is not
- arbitrary `market cap above X` is feasible technically, but product-wise it should likely be bounded to a few allowed thresholds

## Option A: curated/default presets expanded at subscribe time

### Shape

Add a preset catalog, for example:

- `usd-top10`
- `usd-top25`
- `usd-top50`
- `eur-top10`
- `gold-top5`
- `mcap-ge-1b`
- `mcap-ge-100m`

On `/subscribe`, resolve the preset to concrete coin IDs using:

- tracked metadata for peg filtering
- stablecoins cache for current market cap ordering / thresholding

Then write normal rows into `telegram_subscriptions`.

### Pros

- Smallest implementation
- No dispatch-path schema or routing rewrite
- No new cron/materialization job
- `/unsubscribe <ticker>` and `/unsubscribe all` keep working with existing semantics
- Lowest operational risk

### Cons

- This is not a true smart list
- Membership freezes at subscribe time
- If the top 25 changes later, user subscriptions do not update
- `/list` becomes noisier because it only knows about explicit coin rows, not the originating preset

### Assessment

This is very feasible and aligns with the existing design.

If we choose this path, product copy should call them:

- presets
- starter lists
- default lists

Not "smart lists".

## Option B: true dynamic smart lists

### Shape

Introduce a dedicated table, for example:

- `telegram_smart_subscriptions`

Possible rule model:

- `chat_id`
- alert-type flags
- `rule_kind` (`peg_top_n`, `market_cap_ge`)
- `peg_currency` nullable
- `top_n` nullable
- `min_market_cap_usd` nullable
- timestamps

Then at dispatch time:

1. load current alert events
2. load current stablecoins cache
3. evaluate which changed coins belong to which smart-list rules
4. route matching chats alongside explicit per-coin subscribers and global `all`

### Pros

- Real smart-list behavior
- `USD top 25` stays current automatically
- `/list` can represent smart lists cleanly as cohorts instead of 25 individual rows

### Cons

- Requires new schema
- Requires new `/subscribe`, `/list`, and `/unsubscribe` semantics for cohort aliases
- Dispatch now depends on current cohort evaluation, not only explicit coin rows
- Need to decide how `/set` interacts with smart lists
  - likely: not supported initially
  - or only alert on/off, no per-coin tuning
- Need more tests and docs

### Assessment

Still feasible. The data size is small enough that evaluating smart rules in memory during dispatch is fine. The complexity is mostly product semantics and code surface area, not runtime cost.

## Option C: dynamic lists with materialized membership

### Shape

Add:

- `telegram_smart_subscriptions`
- optional materialized membership table

Refresh membership on `sync-stablecoins` or another cron, then dispatch reads the materialized table rather than evaluating rules live.

### Pros

- More scalable and more inspectable
- Avoids doing rule evaluation inside every dispatch run

### Cons

- More moving parts than needed for the current dataset size
- More schema and reconciliation logic
- Harder unsubscribe/provenance handling if mixed with manual rows

### Assessment

Not needed for a first version.

## Recommended rollout

### Recommendation

Start with Option A, but name it honestly:

- "default lists"
- "preset watchlists"

Do not market the first version as a true smart list unless we implement Option B.

### Suggested v1 scope

- support preset aliases in `/subscribe`
- support only a fixed catalog, not arbitrary free-form expressions
- candidate presets:
  - `usd-top10`
  - `usd-top25`
  - `usd-top50`
  - `eur-top10`
  - `gold-top5`
  - `mcap-ge-1b`
  - `mcap-ge-100m`
- command example:
  - `/subscribe dews usd-top25`
  - `/subscribe depeg mcap-ge-1b`

### Why this is the right first cut

- It matches the current architecture
- It avoids a schema migration for the first release
- It keeps the feature easy to explain
- It lets us validate demand before adding a cohort engine

## If product insists on true smart behavior

Preferred second-step design:

- add `telegram_smart_subscriptions`
- keep smart lists separate from `telegram_subscriptions`
- evaluate smart rules in memory during dispatch using current stablecoins cache
- show a separate `Smart lists` section in `/list`
- support unsubscribe by smart-list alias
- defer `/set` support for smart lists until a concrete UX requirement exists

## Implementation notes

### Command UX

Best UX is alias-based, not expression-based.

Prefer:

- `usd-top25`
- `mcap-ge-100m`

Over:

- `marketcap>100m`
- `top25-usd`

Reason:

- easier Telegram parsing
- easier help text
- easier validation
- easier `/unsubscribe` symmetry

### Guardrails

- fixed preset catalog only for v1
- cap preset expansion size
- reject presets that resolve to zero coins
- include resolved count in success copy
- keep list resolution restricted to active tracked stablecoins

### Documentation impact if implemented

At minimum:

- `docs/telegram-alerts.md`
- `docs/api-reference.md` (`POST /api/telegram-webhook` command surface)
- `/telegram` landing-page copy if the feature is promoted publicly

## Bottom line

- Feasible: yes
- Low-risk first version: yes, as preset expansion
- True dynamic smart lists: also feasible, but a bigger product and schema change

Best path:

1. ship curated/default preset lists first
2. observe usage
3. only add a dynamic smart-list model if users clearly want auto-updating membership
