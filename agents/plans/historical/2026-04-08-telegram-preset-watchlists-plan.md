# Telegram Preset Watchlists Implementation Plan

## Objective

Ship a low-risk v1 for Telegram "smart subscribe" demand by introducing **preset watchlists** instead of true dynamic cohorts.

This v1 should let users subscribe to opinionated default lists such as:

- `usd-top10`
- `usd-top25`
- `usd-top50`
- `eur-top10`
- `gold-top5`
- `mcap-ge-1b`
- `mcap-ge-100m`

The feature must also be **explicitly discoverable inside the bot itself**, not just in external docs or on the website.

## Product Decision

### What v1 is

V1 is a **preset watchlist** feature:

- users subscribe to a named preset alias
- the bot resolves that alias to a concrete set of active stablecoin IDs at command time
- the bot stores those as normal `telegram_subscriptions` rows
- dispatch remains unchanged because it still sees plain per-coin subscriptions

### What v1 is not

V1 is **not** a true auto-updating smart list:

- if the composition of `usd-top25` changes later, existing subscribers do not auto-rebalance
- `/list` will show the resulting coin follows, not persistent preset provenance

This naming matters. Public and bot-facing copy should call these:

- preset watchlists
- default lists
- starter lists

Do not call the v1 feature "smart lists" in user-facing copy.

## Why this approach

The current bot is built around:

- explicit per-coin rows in `telegram_subscriptions`
- global all-coin flags in `telegram_subscribers`
- dispatch fan-out keyed by changed `stablecoin_id`

That architecture is a strong fit for preset expansion and a poor fit for dynamic cohort membership.

Using preset expansion gives us:

- no schema migration
- no dispatch rewrite
- no new cron/materialization job
- lower rollout risk
- a truthful product surface

## In Scope

- new preset alias catalog
- preset resolution to concrete coin IDs
- `/presets` bot command for in-bot discoverability
- `/subscribe` support for preset aliases
- `/unsubscribe` support for preset aliases
- updated `/start`, `/help`, and `/list` copy so preset watchlists are explicitly surfaced inside the bot
- targeted docs and tests

## Out of Scope

- true auto-updating smart lists
- any new D1 tables
- dispatch-path changes
- `/set` support for presets
- launch-alert presets
- operator analytics for preset adoption
- persistent preset provenance in `/list`

## Non-Negotiables

- No schema change for v1.
- No change to alert dispatch semantics.
- Presets must only resolve to active tracked stablecoins.
- Presets must be explicitly presented in the bot.
- The bot must remain truthful that presets are expanded at subscribe time.
- The feature must degrade clearly when preset resolution is temporarily unavailable.

## Command Contract

### New command

Add:

- `/presets`

Behavior:

- returns the supported preset watchlists
- groups them by category
- includes one-line descriptions
- includes one or two example subscribe commands

### Updated subscribe contract

Current:

- `/subscribe <types> <tickers>`
- `/subscribe <types> all`

V1:

- `/subscribe <types> <targets...>`

Where `<targets...>` may contain:

- explicit tickers / exact Pharos IDs
- preset aliases
- but not `all` mixed with anything else

Examples:

- `/subscribe dews usd-top25`
- `/subscribe dews depeg usd-top25 eur-top10`
- `/subscribe safety mcap-ge-1b`
- `/subscribe depeg usd-top25 USDC DAI`

Rules:

- `all` remains the existing global all-stablecoins token and is still exclusive
- presets are valid only for `dews`, `depeg`, and `safety`
- presets are invalid with `launch`
- duplicate IDs after preset expansion must be deduped before writes

### Updated unsubscribe contract

Current:

- `/unsubscribe <tickers>`
- `/unsubscribe all`

V1:

- `/unsubscribe <targets...>`

Where `<targets...>` may contain:

- explicit tickers / exact Pharos IDs
- preset aliases

Examples:

- `/unsubscribe usd-top25`
- `/unsubscribe usd-top25 USDC`

Behavior:

- preset aliases resolve to the same coin sets as subscribe
- the bot removes matching `telegram_subscriptions` rows
- `all` keeps its current meaning

### `/set` stays unchanged

Do not support:

- `/set usd-top25 dews WARNING`
- `/set mcap-ge-1b safety downgrade-only`

Reason:

- it turns a simple preset feature into bulk preference editing
- it complicates UX and documentation
- it creates pressure for persistent preset provenance

Keep `/set` strictly:

- per ticker / exact coin id
- or `all` for current global alert flags

## Discoverability Inside The Bot

This is mandatory for the implementation.

### 1. `/start`

Update onboarding copy so preset watchlists are visible immediately.

Add:

- one sentence explaining preset watchlists
- one example using a preset alias
- mention `/presets`

Recommended examples:

- `/subscribe dews usd-top25`
- `/subscribe safety mcap-ge-1b`

### 2. `/help`

Add:

- `/presets` command entry
- preset usage examples under `/subscribe`
- short note that preset watchlists expand into normal coin follows

### 3. `/list`

Keep the core list behavior unchanged, but add a small discoverability hint:

- when there are no subscriptions: mention `/presets`
- when there are subscriptions: include a final tip line pointing to `/presets`

This is important because preset provenance is not stored in v1, so `/list` must still teach the feature.

### 4. Success and error responses

Preset flows should be explicit in the reply text.

On success:

- mention that a preset watchlist was applied
- mention how many coins it resolved to
- keep the full response concise for large cohorts
- direct users to `/list` for the detailed state

On invalid preset or mixed invalid target:

- use copy that says "ticker or preset"
- point users to `/presets`

## Preset Catalog

### Recommended v1 catalog

Peg leader presets:

- `usd-top10`
- `usd-top25`
- `usd-top50`
- `eur-top10`
- `gold-top5`

Large-cap presets:

- `mcap-ge-1b`
- `mcap-ge-100m`

### Why this catalog

- It covers the clear use cases from the request.
- It avoids arbitrary free-form expressions.
- It stays small enough to explain in a single bot message.
- It avoids nonsense cohorts like `eur-top25` or `gold-top25`.

### Resolution rules

All presets resolve only against:

- active tracked stablecoins

No pre-launch assets should be included.

For top-N presets:

- filter by peg currency
- sort by current market cap descending
- break ties by canonical tracked order
- take the first N

For market-cap presets:

- include coins whose current market cap is `>=` the configured threshold
- sort by current market cap descending
- break ties by canonical tracked order

## Data Source Strategy

Use the worker-side stablecoins cache plus shared metadata.

Resolution inputs:

- `loadStablecoinsCache(db, { mode: "strict" })`
- `TRACKED_META_BY_ID`
- `ACTIVE_STABLECOINS`
- `getCirculatingRaw()`
- canonical tracked order from `TRACKED_STABLECOINS`

Reasoning:

- one consistent market-cap source for both top-N and threshold presets
- no external network dependency
- no new tables
- market-cap semantics stay aligned with the rest of the app

### Failure behavior

If the stablecoins cache is unavailable or unusable:

- preset resolution should fail closed
- the bot should reply with a short retry message
- explicit ticker-only subscriptions should continue to work

Recommended copy:

- "Preset watchlists are temporarily unavailable because current market-cap data is unavailable. Try again in a few minutes, or subscribe with explicit tickers."

Do not silently fall back to stale guessed membership.

## Technical Design

### New module

Add a dedicated preset module, for example:

- `worker/src/lib/telegram-presets.ts`

Responsibilities:

- define the preset catalog
- validate whether a token is a supported preset alias
- resolve preset aliases to concrete stablecoin IDs
- provide label/description metadata for bot messages

Suggested types:

- `TelegramPresetId`
- `TelegramPresetDefinition`
- `ResolvedTelegramPreset`

Suggested exported helpers:

- `isTelegramPresetAlias(token: string): boolean`
- `listTelegramPresets(): TelegramPresetDefinition[]`
- `resolveTelegramPresetTargets(db, presetIds): Promise<ResolvedTelegramPreset[]>`

Keep this logic out of `dispatch-telegram-alerts.ts`.

### Parser changes

Current `/subscribe` parsing only classifies:

- alert types
- `all`
- tickers
- invalid tokens

Update it so `/subscribe` target parsing can classify:

- explicit tickers / exact IDs
- preset aliases
- `all`
- invalid tokens

Recommended output shape:

- `alertTypes`
- `subscribeAll`
- `tickers`
- `presetIds`
- `invalidTargets`

Do the same target classification for `/unsubscribe`.

### Resolution flow

Recommended subscribe flow:

1. parse alert types and targets
2. reject invalid combinations:
   - `all` mixed with anything else
   - `launch` with presets
3. resolve preset aliases to concrete IDs
4. resolve explicit tickers through the existing coin-resolution flow
5. combine and dedupe the resulting IDs
6. write normal subscription rows through existing store helpers
7. send a preset-aware success reply

Recommended unsubscribe flow:

1. parse targets
2. resolve preset aliases
3. resolve explicit tickers
4. combine and dedupe
5. call existing `removeSubscriptions()`
6. send a preset-aware removal summary

### Message strategy

Do not dump all 50 resolved coins into the success reply for large presets.

Recommended success format:

- header line: preset(s) applied
- resolved unique coin count
- up to N preview symbols/IDs
- final line: "Use /list to view your full subscription state."

Recommended preview cap:

- 8 to 10 coins

Keep `/list` as the authoritative full state.

## File-Level Workstreams

### 1. Preset catalog and resolver

New:

- `worker/src/lib/telegram-presets.ts`
- `worker/src/lib/__tests__/telegram-presets.test.ts`

Tasks:

- define the v1 catalog
- implement alias validation
- resolve current market-cap ordering from the stablecoins cache
- add deterministic tie-breaking
- add tests for:
  - top-N resolution
  - threshold resolution
  - dedupe behavior
  - active-only filtering
  - failure behavior on missing cache

### 2. Webhook parsing and command handling

Modify:

- `worker/src/lib/telegram-alerts.ts`
- `worker/src/api/telegram-webhook.ts`
- `worker/src/api/telegram-webhook-parsing.ts`

Tasks:

- extend subscribe target parsing to recognize presets
- add unsubscribe target parsing with the same preset support
- add `/presets` routing
- forbid preset use with `launch`
- preserve existing disambiguation behavior for explicit tickers
- ensure preset aliases bypass disambiguation because they are deterministic

### 3. Bot messages and discoverability copy

Modify:

- `worker/src/api/telegram-webhook-shared.ts`
- `worker/src/api/telegram-webhook-messages.ts`

Tasks:

- update `START_MESSAGE`
- update `HELP_MESSAGE`
- add `/presets` message builder
- update empty-state and standard `/list` copy to mention `/presets`
- add compact preset success/review messages
- add invalid target messages that mention `/presets`

### 4. Tests

Modify:

- `worker/src/api/__tests__/telegram-webhook.test.ts`

New:

- `worker/src/lib/__tests__/telegram-presets.test.ts`

Add coverage for:

- `/presets` returns the catalog
- `/start` mentions preset watchlists and `/presets`
- `/help` documents `/presets`
- `/subscribe dews usd-top25`
- `/subscribe safety mcap-ge-1b`
- `/subscribe dews usd-top25 USDC`
- `/subscribe launch usd-top25` rejects cleanly
- `/subscribe dews all usd-top25` rejects cleanly
- `/unsubscribe usd-top25`
- invalid preset/ticker error points to `/presets`
- `/list` empty state mentions `/presets`

Dispatch tests should not need changes if implementation stays true to the no-dispatch-change contract.

### 5. Documentation and public product copy

Modify:

- `docs/telegram-alerts.md`
- `docs/api-reference.md`
- `src/app/telegram/page.tsx`

Recommended optional updates:

- `docs/architecture.md` if the command-surface summary is updated there

Docs updates required:

- add `/presets` to the supported command list
- document the v1 preset catalog
- document that presets expand to normal per-coin follows at subscription time
- document that preset watchlists support `dews`, `depeg`, and `safety`, but not `launch`
- update the public Telegram landing page copy to mention preset watchlists

## Detailed Execution Order

### Phase 1: Contract and preset resolver

Goal:

- finalize the command contract and build the resolver in isolation

Deliverables:

- preset module
- deterministic catalog
- resolver tests

### Phase 2: Webhook integration

Goal:

- wire presets into `/subscribe`, `/unsubscribe`, and `/presets`

Deliverables:

- parser updates
- command handling updates
- no schema changes

### Phase 3: Bot presentation

Goal:

- make preset watchlists explicitly discoverable inside the bot

Deliverables:

- updated `/start`
- updated `/help`
- updated `/list` hints
- compact preset success/error copy

### Phase 4: Docs and public page

Goal:

- align docs and website copy with the shipped behavior

Deliverables:

- updated Telegram docs
- updated API reference
- updated `/telegram` page copy

### Phase 5: Verification

Goal:

- prove the feature without regression to the current bot behavior

Deliverables:

- targeted webhook/preset test coverage
- full repo validation for the touched surfaces

## Acceptance Criteria

The feature is complete when all of the following are true:

- Users can discover preset watchlists through `/start`, `/help`, and `/presets`.
- `/subscribe` accepts preset aliases for `dews`, `depeg`, and `safety`.
- `/unsubscribe` accepts preset aliases.
- Presets resolve only to active tracked stablecoins.
- No schema migration was required.
- No dispatch code changed.
- Success replies explicitly mention preset application and resolved coin count.
- Invalid preset/ticker flows point users to `/presets`.
- The Telegram docs and public Telegram page reflect the new feature.

## Risks and Mitigations

### Risk 1: Bot messages become noisy

Mitigation:

- keep `/presets` concise
- compress preset success replies
- push full detail to `/list`

### Risk 2: Preset provenance is invisible after subscription

Mitigation:

- be explicit in success copy
- keep `/presets` discoverable in `/help` and `/list`
- accept this as a v1 limitation instead of adding storage

### Risk 3: Stablecoins cache is temporarily unavailable

Mitigation:

- fail closed with a clear retry message
- do not create guessed or stale subscriptions

### Risk 4: Scope creep into bulk settings

Mitigation:

- keep `/set` unchanged
- explicitly document preset support as subscribe/unsubscribe only

## Verification Plan

Targeted development loop:

```bash
npm test -- \
  worker/src/api/__tests__/telegram-webhook.test.ts \
  worker/src/lib/__tests__/telegram-presets.test.ts
```

Required completion checks:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Before push:

```bash
npm run test:merge-gate
```

## Recommended Follow-Up After V1

Only consider a v2 if real demand appears for:

- auto-updating membership
- persistent preset provenance in `/list`
- smart-list unsubscribe/status semantics
- preset-scoped `/set`

That v2 should use a dedicated smart-subscription model instead of overloading the v1 preset expansion path.
