# PharosWatchBot Mini App

Runtime contract for PharosWatchBot Mini App launch, payloads, signed auth and confirmed client controls. [Telegram alerts](./telegram-alerts.md) owns bot commands/dispatch/delivery; [architecture](./telegram-architecture.md#9-mini-app-surface) owns the sole implementation roster and seam prohibitions; [BotFather runbook](./runbooks/telegram-mini-app-botfather.md) owns external configuration.

> **Agent navigation** — Start with the [Telegram architecture seam map](./telegram-architecture.md). Client/auth/state sections: [overview](#overview) · [launch surfaces](#launch-surfaces) · [payload scheme](#payload-scheme) · [client state](#client-state-and-control-semantics) · [auth](#auth-model) · [Mini App launch entrypoints](#mini-app-launch-entrypoints) · [frontend main page](#frontend-main-page) · [public pulse](#public-pulse-privacy-and-freshness).

## Overview

The Mini App is the Telegram-native control panel for managing PharosWatchBot subscriptions, quiet hours, snooze state, and delivery health. It is served as a static Next.js route under `/pharoswatchbot/app/` and hosted at `https://pharos.watch/pharoswatchbot/app/`. The route is marked `noindex,nofollow`, disallowed in `robots.ts`, and omitted from the sitemap because it is an embedded tool, not SEO content.

Launch is private-chat scoped for the current phase: bot commands and alert delivery continue to work in groups, but Web App launch buttons are attached only to private-chat replies. Group, supergroup, and channel chats remain in command-only mode until a fresh admin verification path and group-scoped launch ownership model exist.

Unsigned browser **preview** is a permanent launch-guidance state. With no supported Telegram launch hint, it explains how to open the Mini App and makes zero session API calls; it exposes no subscription controls or mutation authority. It is not awaiting promotion to a browser control panel. A Telegram-indicated launch with missing or failed signed data remains the distinct missing/error state, and signed `initData` validation is always the backend authorization boundary. `noindex` and robots exclusion govern discoverability, not access control.


## Personalized Recap Retirement

Personalized watchlist recaps are retired. The command menu, public manual, Mini App controls, signed operations and session state no longer expose recap preferences or delivery history. Stale `set-recap` requests fail operation-schema validation before writes; retired recap launch payloads follow the ordinary unknown-payload Home route. Watchlists, risk alerts, IANA timezone, quiet hours, snooze, delivery health and the public editorial daily/weekly digests are unchanged.


## Launch Surfaces

The static control panel is `https://pharos.watch/pharoswatchbot/app/`. Web App buttons attach only in private chats; addressed commands/callbacks remain the group mutation surface with fresh admin checks. Private direct-link `chat_type="sender"` is the user's private settings context, not group authority.

| Surface | Owner / reconciliation |
| --- | --- |
| Persistent `Manage Alerts` menu | Five-minute Worker lane, 15-minute fresh-cache marker; Bot API failure/backoff can delay drift repair |
| Profile `Launch app`, preview/loading assets | BotFather; use [configured state and smoke tests](./runbooks/telegram-mini-app-botfather.md#configured-state), not a duplicated feature checklist |
| Private command replies / quick-subscribe | `/start`, `/help`, `/presets`, `/settings`, `/list`, `/status`, `/why`, `/coverage`, `/set`, `/mute`, `/unmutehours`, `/timezone`, `/unsnooze`, `/pause`, `/health`, `/forget` attach context-aware buttons; quicksub uses `coin_<id>` |
| Direct `https://t.me/PharosWatchBot?startapp=<payload>` | Shared payload parser chooses view; signed `initData` still authorizes every API operation. Stale-auth relaunch preserves current panel/context |

Groups keep command/callback keyboards; no group Mini App mutation until fresh admin verification and group-scoped launch ownership exist.

## Payload Scheme

The shared parser in `shared/lib/telegram-mini-app-payloads.ts` owns `?startapp=` routing. This view parameter is not the bot's `/start` command parameter: the Worker parser intentionally accepts only command schemes. Both share `[A-Za-z0-9_-]`, normalize ASCII case to lowercase and emit lowercase/no-space tokens, but Mini App accepts up to 512 characters and bot `?start=` only 64.

| Payload | Initial view |
| --- | --- |
| absent / unknown / `home`, `snooze`, `health` | Home |
| `settings`, `quiet-hours`, `forget` | Settings (matching control context) |
| `watchlist`, `setup_recommended` | Watchlist (`setup_recommended` is a legacy launch alias) |
| `presets` | Presets |
| `coin_<id>` | Watchlist coin/followable launch target |
| `why_<id>`, `coverage_<id>` | Watchlist in-app insight with bot-DM full explainer fallback |
| allowlisted `pw1_*` adoption token | Home/Watchlist according to its destination |

Unfollowed catalog coins render Follow/Why/Coverage/View actions; IDs absent from catalog render read-only no-change fallback. Signed `initData.start_param` outside the payload envelope is ignored as null, not a session rejection. Every payload is untrusted; only signed `initData` grants API authority.

`sample` is deliberately **not** a Mini App view: Home opens `https://t.me/PharosWatchBot?start=sample` through `openTelegramLink` for the private synthetic preview. `sub_*`/`status_*` likewise remain bot-command paths; Mini App never calls the Bot API.

`recommended-setup` is the fail-closed DEWS+depeg `usd-top25` mutation defined by `shared/lib/telegram-mini-app-contract.ts`; broader preset follows use `follow-preset`.

## Configuration Portability

The private Settings panel owns lossless watchlist export/import; command portability and group import/export are retired. Export returns one portable `pw3` token for direct/local rows and followed presets, preserving six-family flags, override markers, tuning, and independent preset policies. It fails closed rather than omitting unavailable rows. Import is always two-stage: a signed read computes an exact replacement preview, then a separate confirmation revalidates both the subscriber preference generation and a server-derived preview fingerprint before applying the existing atomic import path. Supported private launch contexts are absent `chat_type`, `private`, and `sender`; group, supergroup, and channel contexts cannot export, preview, or confirm.

The preview lists every direct and preset add, remove, and change, then separately names broadened and removed alert-family coverage. Global-all settings, quiet hours, timezone, chat snooze, pending actions, and delivery history remain outside the token; retained per-coin rows keep their snooze, while removed rows lose it. Tokens and previews remain request-local and React-session-local: the Mini App does not persist them to browser storage, analytics, logs, or D1.

Portable-token framing is shared by `pw2` and `pw3`: prefix/base64 framing and digest integrity precede bounded gzip/JSON decoding, embedded-version admission, registry provenance and row validation; only valid empty rows return `empty`. Their direct-row codecs remain distinct (`pw3` adds freeze intent), and historical V1/V2 codec reads remain compatible, including copied command wrappers. Mini App replacement continues accepting V2/V3 only; retiring commands does not add a V1 mutation path or retire its decoder. The digest detects copy/paste corruption, not authentication.

Export and preview are read-only operations. They accept the 24-hour signed-session freshness window, use the existing session throttle, and do not consume the Mini App mutation burst. Confirmation is a write: it retains the 5-minute mutation-auth window and burst limiter, fails with `stale-import-preview` when state changed after preview, and never automatically retries. A stale-auth user may still export or preview readable state, but must relaunch before confirming.

## Bulk Watchlist Management

Bulk edits preview/apply at most 20 direct additions/removals, rejecting empty, duplicate, overlapping or oversized selections. Adds default to DEWS+depeg; removals affect selected direct rows only, never materialize preset/global inheritance.

Preview is a 24h signed read describing exact adds/removes/already-matching and remaining inherited coverage. Confirmation re-reads direct state, requires unchanged generation plus fingerprint, and commits every row with one generation transition in a bounded batch. Drift returns `stale-bulk-preview`; never retry automatically.

The five-second undo requires exact post-edit generation/fingerprint. Restore full removed rows (six flags, override markers, tuning, snooze) and remove newly added rows; intervening intent makes undo stale. Single removal uses the same contract: keep only server-derived `undo` for the toast, submit `undo-bulk-watchlist`, never reconstruct a `set-coin` patch from rendered state. Invalid/stale undo changes nothing; no auto-retry.

Preset edits keep at least one DEWS/depeg/safety family enabled; disable the final toggle and direct users to Unfollow. A non-null `depegStepBps` enables depeg unless that same patch explicitly disables it; Worker guarantees the semantics, not only frontend.

`subscriptions[]` includes enabled flags, marked overrides and snooze-only rows, hiding all-disabled/unmarked/unsnoozed residue. Launch/reserve/freeze are per-coin/global on/off only; an untunable-only coin says “on/off only. No tuning.” No reserve/freeze threshold is exposed.

## Seam Rules

[Architecture §9](./telegram-architecture.md#9-mini-app-surface) owns dependency prohibitions and the implementation roster. Mini App routes do not receive webhook updates or call the Bot API. Subscription SQL stays in existing State helpers, group writes stay denied, and no analytics/counter/cooldown write precedes valid signed auth. Capability/schema/body rejection is pre-write; frontend preview or version negotiation grants no mutation authority.

## Contract And Catalog Versioning

`shared/lib/telegram-mini-app-contract.ts` owns operation/DTO schemas, error codes, contract version and opaque revision. Both Worker and client import it; never mirror a literal version or schema. The optional server-derived removal `undo` snapshot reuses the bounded bulk undo contract.

Tuning schemas consume the shared preference vocabulary in `shared/types/status/telegram.ts`; settings callback maps and inverses live in `shared/lib/telegram-alert-families.ts`. These are representation authorities, not a contract-version change: callback codes/order, portable-token ordinals and historical fixture bytes remain stable. Nullable Mini App tuning still means enabled default/any, never the settings keyboard's Off action.

Contract **v7** removes personalized recap operations, response projections, errors and launch tokens. Deploy the v7 Worker before Pages. Explicit earlier contract versions, including v5 and v6, are rejected before writes; there is no versioned compatibility adapter. The corrected tuning and preset-edit semantics described below remain unchanged. Existing disabled rows are not automatically restored because intent cannot be recovered from those rows.

The searchable coin catalog is projected by `scripts/build-data/build-client-registry.mjs` into `shared/data/stablecoins/coins.telegram-mini-app.generated.json`. `shared/lib/telegram-mini-app-catalog.ts` combines that slim asset with the shared preset definitions and derives a content version. The slim catalog is bundled into the fingerprinted static Mini App JavaScript, so it is cached with the Pages asset instead of being returned by every signed API call. The repository does not currently define a fixed byte budget for this registry-sized artifact.

Clients advertise `mini_app_contract` and `mini_app_catalog` query parameters. A matching Worker returns `{ contractVersion, catalogVersion, stateRevision, state }`; `state` contains only viewer/subscriber/preset/subscription/health data and never the immutable catalog. A request with neither parameter remains an unversioned legacy client and receives the full-catalog state shape, without retired recap fields or operations. Query negotiation avoids adding custom request headers. The v7 client must not ship before the v7 Worker: an earlier version-aware Worker rejects v7.

Version skew returns `409 contract-version-mismatch` or `409 catalog-version-mismatch` before auth cooldown, mutation burst, analytics, or persistence writes. The client does not replay a rejected mutation. It stores only the non-identifying target-version pair in `sessionStorage` and reloads the fingerprinted static bundle at most once for that target; a repeated mismatch asks the user to close and reopen the Mini App.

## Client State And Control Semantics

The client renders only server-confirmed state. A mutation leaves the pressed/selected value unchanged while its request is pending, marks the initiating control busy, disables the other mutation controls, and replaces state only after a successful response. A failed mutation therefore keeps the previous confirmed value without a misleading optimistic flip or rollback animation.

Coin tuning **Default** (DEWS/safety) and **Any depeg** keep that family enabled with null tuning, and establish the per-coin override rather than suppressing inherited alerts. Default DEWS means **ALERT or higher**, not every band; default safety means all changes. Only an explicit `alertTypes: { family: false }` turns a family Off, including when the same patch carries null tuning. Bot callback token `0` remains Off and is not the Mini App domain representation of Default/Any.

`follow-preset` edits replace explicitly supplied family flags; omitted flags retain the followed preset's value (or start disabled for a new follow). The Store merges field-presence flags against the current row inside the transaction, so interleaved partial edits cannot restore omitted flags from a stale read. A non-null depeg step enables depeg unless the patch explicitly sets depeg false; disabling depeg clears its step. At least one preset family must remain enabled; use Unfollow to remove the last one. This invariant is checked against that same transaction row before any subscriber, adoption or preset write. The preset update, subscriber activity and preference-generation transition commit atomically without altering direct/local rows. Command `/subscribe` remains additive and unions families.

Portable previews and direct-removal undo capture direct flags/overrides/tuning, raw coin snoozes, presets and preference generation in one SQL statement snapshot. A later preference write makes the generation-guarded confirmation/removal fail rather than pairing older settings with a newer generation. Undo restores snoozes from that same capture; portable tokens still exclude snoozes. Empty retained subscribers remain distinct from absent subscribers.

Export encodes only coins still in the tracked registry; an encode failure is a server error, never `empty-portable-state`. Import skips direct rows for coins that are no longer subscribable (delisted, quarantined, frozen) instead of rejecting the token, and leaves the chat's own rows for those coins unchanged. `remove-coin` also deletes a stored row whose coin has left the registry, without an undo.

Successful `forget-me` is terminal for the open client: retained state and undo are cleared, signed reads/writes and refreshes are revoked, and native Back/Settings/Main buttons are hidden and detached. Captured late callbacks cannot dispatch; only Close remains.

Every successful session read or mutation also records the response `stateRevision` and the local receive time. For an older Worker's full-state response, the client derives the same opaque revision with `telegramMiniAppStateRevision()` after excluding the bundled catalog. If a later session refresh fails, the last confirmed state stays visible but the shell enters an explicit stale mode: it shows the revision and refresh time, disables all mutations, and requires a successful **Retry refresh** before editing becomes available again. Stale data is never silently presented as current, and a failed refresh never discards a user's readable settings.

Watcher status uses enabled global/direct/preset families, not row existence: retained empty subscribers have no enabled alerts. Indefinite pause and timed snooze suppress the active heading; timed snoozes expire at the shared client `nowSec` deadline. Delivery history remains visible independently.

Delivery health shows separate latest successful alert and command-reply clocks; neither is evidence that the other lane succeeded. Late diagnostic writes do not move these clocks backward or clear a newer failure. Equal-second failures remain visible even beside a successful reply/delivery; the full reconciliation rule is owned by [State / persistence](./telegram-architecture.md#7-state--persistence).

Suggested-coin actions work read-only: followed suggestions focus/highlight their card; unfollowed ones focus search. Relaunch uses current coin/insight context after the transient highlight ends; leaving Watchlist clears it.

Timezone choices are current, detected, session-recent and common, with full IANA search. Null uses UTC without confirmation; **Confirm UTC** persists `"UTC"`, while **Clear timezone** persists null. Recents follow confirmed snapshots only. Acknowledged quiet-hour drafts clear so later snapshots own the selects; genuinely unsaved edits remain labelled.

Quiet-hours OFF retains the saved start/end. Enabling with both hours omitted atomically reuses a valid saved window, defaulting to 22–07 only when unconfigured or invalid. Supplying hours is an explicit window update (an omitted counterpart keeps its documented default), distinct from an enabled-state toggle; timezone interpretation is unchanged.

## Effective Alert Source

Each direct/local coin row's `CoinCard` renders a compact source chip derived purely from already-projected session state (`computeEffectiveSource(coin, globalAlerts, presets)` in `src/app/pharoswatchbot/app/format.ts`), so it adds no extra reads. The session payload includes the six `alertOverrides` markers alongside the six alert flags; the client must use those markers rather than interpreting every zero flag as an opt-out. The helper mirrors the `/list` precedence model (**per-coin > preset > all-stablecoins**, see [`telegram-alerts.md`](./telegram-alerts.md)), while the current chip copy collapses preset/global coverage into inherited-default labels because the session payload does not expand preset membership per coin:

- **Per-coin** — the coin has at least one explicit per-coin alert flag enabled; that lane wins over preset/global.
- **Muted override** — at least one inherited family is off with its matching explicit override marker set, so that family suppresses the preset/global default.
- **All-stablecoins** — fallback chip for displayed snooze-only/off rows with no enabled per-coin flag and no marked-off override; those families simply inherit whatever preset/global coverage exists, including none.

`computeEffectiveSource` returns the source per alert type; the chip shows the dominant display lane. An unmarked off flag inherits preset/global coverage and never renders as an opt-out. `PresetsPanel` labels preset coverage at the preset level only; it does not expand presets into member coins because preset-to-coin membership is dynamic, absent from the session payload, and authoritative only when resolved against the current cache. Following and unfollowing a preset changes `telegram_preset_subscriptions` plus the subscriber row's activity and preference-generation markers in `telegram_subscribers`; direct/local coin rows in `telegram_subscriptions` remain unchanged.

## Auth Model

`validateTelegramMiniAppInitData` in `worker/src/telegram/mini-app/mini-app-auth.ts` owns Telegram HMAC validation and timing-safe comparison. Require signed hash, auth date and user; untrusted browser fields or launch hints are not identity. Try current bot token then configured previous token for overlap ([secret rotation](./runbooks/telegram-secret-rotation.md)); outbound sends use current token only.

Freshness windows:

- **Reads:** signed `auth_date` within 24h for session, export and previews.
- **Writes:** signed `auth_date` within five minutes. One launch may make multiple edits with the same `initData`; no rolling refresh or one-shot replay claim is allowed. Never persist raw `initData`.
- **Expired launch is terminal on the client:** Telegram never refreshes `initData` inside a running Mini App, so any `stale-auth` (a session read past 24 hours, a write past five minutes, or a server state with `mutationBlockReason = "stale-auth"`) puts the shell in one reopen state: a "Reopen to edit" banner, and the native MainButton reads "Reopen to edit" (relaunch via `openTelegramLink` preserving current panel/coin/insight; inline button only when no MainButton exists), and a Close action calls `webApp.close()`. Edit expiry alone keeps refreshing readable state (signed reads stay valid for 24 hours), and stale-data or error banners still show beside it. Only a `stale-auth` on a session read or signed read (export, import/bulk preview) ends the session: it disables further signed reads and stops the visibility auto-refresh, header refresh and Retry from resending the same `initData`, and then the reopen banner replaces every other status banner. Private-chat controls stay readable and tappable rather than greyed out; an edit attempted in this state is never sent and its intent stays visible ("Not saved: …") instead of being discarded.
- **Telemetry:** signed stale rejections record one aggregate event per expired `initData` and surface (keyed by the first 16 hex characters of the signed `hash` in the per-user command-cooldown cache, held for 7 days to match short-lived chat cache retention), so counts measure incidents, not client retries. Every retry still returns `401 stale-auth`; the dedupe gates only the telemetry write. Reads use `mini_app_session_invalid`; writes use `mini_app_mutation_denied`, failure `stale-auth` and normalized `mutationActionDetail`, not raw operation kind. Portability/bulk previews record `mini_app_portability`.
- **Burst admission:** 12 schema/signature-valid attempts per user in an anchored 30-second window beginning with first admission, not wall-clock buckets. Excess returns 429 with identical integer `retryAfterSec`/`Retry-After`. Disable writes with visible non-live countdown and one polite announcement at start/end; keep reads available and require explicit action afterward, never replay.
- **Budget retention:** burst is independent of profile ownership, domain idempotency and webhook dedupe. `/forget` deletes subscriber/watchlist state and all raw chat-keyed cache entries, including legacy burst keys, but cannot reset the remaining admission budget. D1 stores only a bot-token HMAC of user plus a short epoch, count and original window clock; the current/previous epoch lookup preserves the anchored deadline across an epoch boundary. An anonymous identity serves only that <=30-second window, never a cross-window profile identifier, and neither forgetting nor rejected attempts extends it. Expired anonymous rows have no admission authority or cross-window identity and are physically pruned by the existing daily bounded cache cleanup; this is not a 30-second physical-deletion guarantee.
- **Body/auth order:** both endpoints cap bodies at 16 KiB using declared length and bounded streams before JSON/schema/HMAC. Rejected body/JSON/schema never touches D1. [Ingress runbook](./runbooks/telegram-webhook-retry-dedupe.md#preauth-ingress-abuse-controls) owns early limiter interpretation.
- **Privacy:** exact embedded route/descendants omit Google Analytics, page views/events/Web Vitals and GA/Tag Manager CSP origins while permitting Telegram bridge; public landing retains normal configured analytics. First-party usage/adoption aggregates are signed-auth-only and identifier-free. A validated mutable session writes one 30-minute chat-keyed start/allowlisted-placement correlation; first successful mutation atomically consumes it into one latency bucket. Retention and `/forget` clear it; preauth rejection writes nothing.
  First effective follow is claimed inside the same Store mutation transaction (including import/bulk generation guards), with signed launch campaign/placement dimensions. Off-only, snooze-only, stale/no-op and failed changes do not manufacture a follow; existing active rows with missing historical milestones are not current-time backfilled. The [adoption runbook](./runbooks/telegram-adoption-report.md#interpretation-rules) owns repair evidence requirements.
- **Groups:** group/supergroup/channel stay read-only, visibly directing users to `/settings@PharosWatchBot` in the group.

Theme normalization belongs to `telegram-theme.ts` / `applyTelegramTheme()`: preserve compliant host colors and minimally mix hostile colors to AA text/button `4.5:1` and controls/borders/focus `3:1`. `.pharos-mini-app` scopes semantic tokens to that palette. CSS seeds host color scheme before bridge; invalid/absent anchors clear stale inline values and retain fallback. Viewport, safe-area and focus offsets remain independent.

## BotFather Operator Checklist

BotFather-owned items (Main Mini App URL, profile launch toggle, preview screenshots, loading-screen icon, loading background color) are not reconciled by Worker code. The current configured state plus deploy-time smoke tests live in [`runbooks/telegram-mini-app-botfather.md`](./runbooks/telegram-mini-app-botfather.md). Verify quarterly or after a BotFather UI change.

## Debugging Workflow

Real-device inspection paths for triaging Mini App issues:

- **Telegram Desktop Beta** — `Settings → Advanced → Experimental settings → Enable webview inspecting`, then right-click → Inspect inside the Mini App for full Chrome DevTools.
- **Telegram macOS Beta** — 5-tap the Settings icon → Debug Menu → Debug Mini Apps.
- **Android USB** — Telegram Settings → double-long-press the version label → Enable WebView Debug, then attach `chrome://inspect/#devices`.
- **iOS Safari** — cable to a Mac and use Safari's Develop menu → device list.
- **Eruda toggle** — appending `?debug=eruda` to the Mini App URL loads Eruda from CDN when `NODE_ENV !== "production"`. Use this when you need an in-Telegram console without changing code. The toggle is no-op in production builds.

For incident triage, use the [complete Telegram runbook hub](./telegram-alerts.md#runbooks) rather than DevTools. Mini App-specific entry points:

- [`runbooks/telegram-mini-app-auth-failures.md`](./runbooks/telegram-mini-app-auth-failures.md) — `mini_app_session_invalid` spikes.
- [`runbooks/telegram-preset-resolution-failure.md`](./runbooks/telegram-preset-resolution-failure.md) — `presetQueryFailures` / `presetResolutionFailures` rising.
- [Ingress/setup incidents](./runbooks/telegram-webhook-retry-dedupe.md#setup-state) — setup wizard does not progress.
- [`runbooks/telegram-group-admin-gating-rollback.md`](./runbooks/telegram-group-admin-gating-rollback.md) — flipping the group admin gate from hard to soft.

## Test Fixtures

`shared/test-utils/telegram-mini-app-state.ts` owns session-state builders for frontend and shared contract tests; mutable-state fixtures omit its catalog.

Before a release that changes Mini App layout, theme, auth, or mutations, an operator verifies a real Telegram session:

1. Open a populated private session on current Telegram iOS, Android, and Desktop in light and dark appearance.
2. Visit all four panels; use VoiceOver or TalkBack on one mobile client and keyboard-only navigation on Desktop, including arrow-key tab movement and visible focus.
3. Repeat one mobile pass with the OS large-text setting and reduced motion enabled; rotate once and inspect top/bottom controls on a device with safe-area insets.
4. On Desktop, check browser/WebView zoom at 200% and confirm controls reflow without horizontal page scrolling or hidden focused controls.
5. Verify group read-only copy with edits disabled, and the single stale-auth reopen state (MainButton "Reopen to edit", Close, no Retry, unsaved edits shown as intent). Use a non-production test subscriber for the destructive forgotten-state check.

Record the Telegram/client version, OS/device, appearance, assistive setting, and result in the release handoff. These are operator checks; CI does not report them as automated passes.

## Mini App Launch Entrypoints

[Launch surfaces](#launch-surfaces) is the single inventory for Worker-reconciled and BotFather-owned entrypoints. [Payload scheme](#payload-scheme) owns view routing; the [BotFather runbook](./runbooks/telegram-mini-app-botfather.md#smoke-tests) owns operator configuration and real-client launch tests.

## Frontend Main Page

`src/app/pharoswatchbot/page.tsx` serves public `/pharoswatchbot/` using the shared feature shell, linked from Tools and the homepage status strip. `/telegram` and descendants redirect to canonical matching paths. It explains the bot, public digest/community channels, six verbatim family samples, low-noise setup/tuning, private recap, reliability/privacy, and filterable command reference derived from shared manifests. Visible FAQ/setup/application metadata must agree with page copy, not become an independent behavior inventory.

The page reads `/_site-data/telegram-pulse` for public adoption counts/top follows/history only; it never calls mutating bot APIs and exposes no operational Mini App/queued-delivery counters. Unavailable pulse renders `—`, never retained counts; loading/unavailable states are named polite status regions with busy state. Samples derive verbatim from `shared/lib/telegram-alert-samples.ts`.

The recommended `pw1_landing_setup` link preloads DEWS+depeg `usd-top25` confirmation and preserves attribution through first follow: no extra branch choice or silent subscription. Recap copy retains private scope, confirmed timezone, material-change suppression and separation from market-wide Digest. Component order/layout is owned by the route, not mirrored here.

## Public Pulse Privacy And Freshness

The public pulse keeps the exact `activeWatchers` total visible by product decision, because it is the primary adoption signal on the public page. Low-cardinality supporting metrics are more sensitive while the bot is small: nonzero values below 5 are suppressed for daily new/churn/reactivation deltas, pending deliveries when available, Mini App session/mutation totals, and lifecycle-history delta fields. Suppressed fields are listed in `privacy.suppressedFields`; consumers should omit those tiles instead of rendering zero. Mini App denied counters are an explicit exception: they are abuse/health counters, so they remain visible even below the threshold and are not listed in `privacy.suppressedFields`. Replay-class auth counters are reserved for future telemetry unless a producer is wired.

Pulse publication reuses heavy public sections on a 15-minute cadence, but only within the same UTC day. Mini App "today" counters reload after midnight UTC even when the previous heavy-section snapshot is still inside the reuse window.

Publication is ordered so the heavy-section reuse marker can never claim work that was not durably published: the snapshot cache write commits first, and only then does the marker advance. A failed snapshot write surfaces as an `error` outcome on the `telegram-pulse-snapshot` scheduled sidecar (with `snapshotPublished: false` and the write error preserved in the cron metadata) instead of being swallowed; a failed marker write after a successful snapshot write degrades the sidecar and leaves the marker behind so the next run recomputes the heavy sections.

Adoption retention does not clamp independent counts: a cohort whose retained numerator exceeds its aggregate denominator is omitted as `cohort-evidence-mismatch`, with bounded raw counts in the refresh outcome/operational warning. Unaffected cohorts and the public pulse still publish; raw cohort diagnostics are not added to the public payload.

`quality.status` is `partial` when a non-critical public telemetry loader failed. Absent pulse `quality` is `unknown`, never `complete`. Public copy stays generic and never includes raw D1 or provider errors; Access-gated `/api/status` keeps field-level Telegram telemetry diagnostics for operators. Unavailable telemetry takes precedence over privacy suppression: if `pendingDeliveries` cannot be loaded, the response returns `pendingDeliveries: null` and lists `pendingDeliveries` in `quality.unavailableFields`, not in `privacy.suppressedFields`.

All live placements withdraw counts and the success badge on refresh failure, even with retained query/count-up data; a successful refresh restores them. Rankings/history check `quality.unavailableFields` before rows; empty placeholders require successful reads.

Freshness is split deliberately:

- `currentSnapshotAt` / `updatedAt` describe the current aggregate pulse, refreshed on the 5-minute Telegram pulse cadence.
- `lifecycleHistoryUpdatedAt` describes the latest persisted daily lifecycle snapshot. `historySource` is always `snapshot`; unavailable snapshot history is reported through `quality.unavailableFields` rather than reconstructed from current subscriber cohorts.
- `lifecycleHistoryEverySeconds=900` documents the lifecycle snapshot refresh cadence.
- Heavy public pulse sections (`topCoins`, lifecycle history, and Mini App daily usage counters) are reused for up to 15 minutes when the cached pulse is valid. The current aggregate counts still refresh on the 5-minute pulse cadence, and pending-delivery count can reuse the dispatch lane's pending-capacity snapshot.

The public chart contains at most 90 completed UTC days of persisted lifecycle snapshots. Daily subscribe, unsubscribe, and reactivation counts come from transition events captured when subscription state changes; the current partial UTC day is never presented as finalized history.

Live opt-ins include every alert family, but historical snapshot writes retain only the daily table's supported columns: reserve/freeze family counts and the all-types conjunction are not persisted. One fixed ordered column/value list drives insert, update and bindings; adding a live family does not silently expand historical storage.

Pulse snapshot publication is generation-fenced: an older build cannot replace a newer generation. `miniAppOpenToFirstMutationP50Sec` uses the selected daily latency-bucket midpoint, stays null/privacy-suppressed below five known-latency sessions, and excludes unknown session correlations. Lifecycle-event/preset read failure publishes affected fields as null in `quality.unavailableFields`, never synthetic zero.
