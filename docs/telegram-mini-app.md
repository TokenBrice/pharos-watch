# PharosWatchBot Mini App

Runtime contract for PharosWatchBot Mini App launch, payloads, signed auth and confirmed client controls. [Telegram alerts](./telegram-alerts.md) owns bot commands/dispatch/delivery; [architecture](./telegram-architecture.md#9-mini-app-surface) owns the sole implementation roster and seam prohibitions; [BotFather runbook](./runbooks/telegram-mini-app-operations.md#botfather-configuration) owns external configuration.

> **Agent navigation** — Start with the [Telegram architecture seam map](./telegram-architecture.md). Client/auth/state sections: [overview](#overview) · [launch surfaces](#launch-surfaces) · [payload scheme](#payload-scheme) · [client state](#client-state-and-control-semantics) · [auth](#auth-model) · [Mini App launch entrypoints](#mini-app-launch-entrypoints) · [frontend main page](#frontend-main-page) · [public pulse](#public-pulse-privacy-and-freshness).

## Overview

The Mini App is the Telegram-native control panel for managing PharosWatchBot subscriptions, quiet hours, snooze state, and delivery health. It is served as a static Next.js route under `/pharoswatchbot/app/` and hosted at `https://pharos.watch/pharoswatchbot/app/`. The route is marked `noindex,nofollow`, disallowed in `robots.ts`, and omitted from the sitemap because it is an embedded tool, not SEO content.

Launch is private-chat scoped for the current phase: bot commands and alert delivery continue to work in groups, but Web App launch buttons are attached only to private-chat replies. Group, supergroup, and channel chats remain in command-only mode until a fresh admin verification path and group-scoped launch ownership model exist.

Unsigned browser **preview** is a permanent launch-guidance state. With no supported Telegram launch hint, it explains how to open the Mini App and makes zero session API calls; it exposes no subscription controls or mutation authority. It is not awaiting promotion to a browser control panel. A Telegram-indicated launch that never yields signed data remains the distinct missing/error state; when the WebApp SDK fails to load, the client falls back to the signed `tgWebAppData` payload already present in the launch URL. Signed `initData` validation is always the backend authorization boundary. `noindex` and robots exclusion govern discoverability, not access control.


## Personalized Recap Retirement

Personalized watchlist recaps are retired. The command menu, public manual, Mini App controls, signed operations and session state no longer expose recap preferences or delivery history. Stale `set-recap` requests fail operation-schema validation before writes; retired recap launch payloads follow the ordinary unknown-payload Home route. Watchlists, risk alerts, IANA timezone, quiet hours, snooze, delivery health and the public editorial daily/weekly digests are unchanged.


## Launch Surfaces

The static control panel is `https://pharos.watch/pharoswatchbot/app/`. Web App buttons attach only in private chats; addressed commands/callbacks remain the group mutation surface with fresh admin checks. Private direct-link `chat_type="sender"` is the user's private settings context, not group authority.

| Surface | Owner / reconciliation |
| --- | --- |
| Persistent `Manage Alerts` menu | Five-minute Worker lane, 15-minute fresh-cache marker; Bot API failure/backoff can delay drift repair |
| Profile `Launch app`, preview/loading assets | BotFather; use [configured state and smoke tests](./runbooks/telegram-mini-app-operations.md#configured-state), not a duplicated feature checklist |
| Private command replies / quick-subscribe | `/start`, `/help`, `/presets`, `/settings`, `/list`, `/status`, `/why`, `/coverage`, `/set`, `/mute`, `/unmutehours`, `/timezone`, `/unsnooze`, `/pause`, `/health`, `/forget` attach context-aware buttons; quicksub uses `coin_<id>` |
| Direct `https://t.me/PharosWatchBot?startapp=<payload>` | Shared payload parser chooses view; signed `initData` still authorizes every API operation. Stale-auth relaunch preserves current panel/context |

Groups keep command/callback keyboards; no group Mini App mutation until fresh admin verification and group-scoped launch ownership exist.

## Payload Scheme

The shared parser in `shared/lib/telegram-mini-app-payloads.ts` owns `?startapp=` routing. This view parameter is not the bot's `/start` command parameter: the Worker parser intentionally accepts only command schemes. Both share `[A-Za-z0-9_-]`, normalize ASCII case to lowercase and emit lowercase/no-space tokens, but Mini App accepts up to 512 characters and bot `?start=` only 64.

| Payload | Initial view |
| --- | --- |
| absent / unknown / `home`, `snooze`, `watchlist`, `presets`, `setup_recommended` | Home |
| `settings`, `quiet-hours`, `forget`, `health` | Home → Settings |
| `setup` | Home → Add coins for every user (Back returns to Home, the setup screen for new users). Onboarding's "Choose my own coins" button targets it |
| `coin_<id>`, `why_<id>`, `coverage_<id>` | Home → Coin detail (the in-app Why/Coverage panel is retired; Coin detail offers "Explain in chat") |
| allowlisted `pw1_landing_*` link token (`shared/lib/telegram-landing-links.ts`) | Home |

The client has no tabs: Home is the root of a screen stack and every other screen (Coin detail, Add coins, Preset detail, Follow a preset, Settings) is pushed with Telegram's BackButton; the SettingsButton pushes Settings. An unfollowed catalog coin's detail is read-only (On/Off per family, no switches or snooze, which would silently follow it) and offers the MainButton "Follow SYM"; an ID absent from the catalog renders a read-only no-change fallback. Signed `initData.start_param` outside the payload envelope is ignored as null, not a session rejection. Every payload is untrusted; only signed `initData` grants API authority.

`sample` is deliberately **not** a Mini App view: Home opens `https://t.me/PharosWatchBot?start=sample` through `openTelegramLink` for the private synthetic preview. `sub_*`/`status_*` likewise remain bot-command paths; Mini App never calls the Bot API.

`recommended-setup` is the fail-closed DEWS+depeg `usd-top25` mutation defined by `shared/lib/telegram-mini-app-contract.ts`; broader preset follows use `follow-preset`.

## Configuration Portability

Watchlist token export/import (legacy V1, `pw2` and `pw3` tokens) is retired in both the bot and the Mini App: the contract no longer admits `export-watchlist`, `preview-watchlist-import` or `confirm-watchlist-import` (they fail schema validation with no D1 access), and no token is issued or decoded. Use [bulk watchlist management](#bulk-watchlist-management) to add or remove up to 20 direct rows at once.

## Bulk Watchlist Management

The client's Add coins screen is one multi-select over the catalog: ticking an unfollowed coin adds it, unticking a followed coin removes it, and the MainButton ("Add N coins") runs the preview and the confirmation back to back, then offers Undo in the snackbar. Bulk edits preview/apply at most 20 direct additions/removals, rejecting empty, duplicate, overlapping or oversized selections. Adds default to DEWS+depeg; removals affect selected direct rows only, never materialize preset/global inheritance.

Preview is a 24h signed read describing exact adds/removes/already-matching and remaining inherited coverage. Confirmation re-reads direct state, requires unchanged generation plus fingerprint, and commits every row with one generation transition in a bounded batch. Drift returns `stale-bulk-preview`; never retry automatically.

The five-second undo (a snackbar action) requires exact post-edit generation/fingerprint. Restore full removed rows (six flags, override markers, tuning, snooze) and remove newly added rows; intervening intent makes undo stale. A direct row whose only flags are the retired launch family is dormant: presence checks follow the live-family projection, so adding that coin replaces the dormant row and undo restores it rather than deleting it. Single removal uses the same contract: keep only server-derived `undo` for the toast, submit `undo-bulk-watchlist`, never reconstruct a `set-coin` patch from rendered state. Invalid/stale undo changes nothing; no auto-retry.

Preset edits keep at least one DEWS/depeg/safety family enabled; the final switch is disabled and Preset detail points users to Unfollow. A non-null `depegStepBps` enables depeg unless that same patch explicitly disables it; Worker guarantees the semantics, not only frontend.

`subscriptions[]` includes enabled flags, marked overrides and snooze-only rows, hiding all-disabled/unmarked/unsnoozed residue. Launch/reserve/freeze are per-coin/global on/off only; an untunable-only coin says “on/off only. No tuning.” No reserve/freeze threshold is exposed.

## Seam Rules

[Architecture §9](./telegram-architecture.md#9-mini-app-surface) owns dependency prohibitions and the implementation roster. Mini App routes do not receive webhook updates or call the Bot API. Subscription SQL stays in existing State helpers, group writes stay denied, and no analytics/counter/cooldown write precedes valid signed auth. Capability/schema/body rejection is pre-write; frontend preview or version negotiation grants no mutation authority.

## Contract And Catalog Versioning

`shared/lib/telegram-mini-app-contract.ts` owns operation/DTO schemas, error codes, contract version and opaque revision. Both Worker and client import it; never mirror a literal version or schema. The optional server-derived removal `undo` snapshot reuses the bounded bulk undo contract.

Tuning schemas consume the shared preference vocabulary in `shared/types/status/telegram.ts`; settings callback maps and inverses live in `shared/lib/telegram-alert-families.ts`. These are representation authorities, not a contract-version change: callback codes/order and historical fixture bytes remain stable. Nullable Mini App tuning still means enabled default/any, never the settings keyboard's Off action.

Contract **v9** adds `presets[].memberIds`: the followed group's current members, resolved against the strict market-cap cache in the same session read. A failed resolution returns `null` (unknown), never `[]`, and the client then says a preset's coverage "can't be checked" rather than claiming or denying it. Contract v7 removed personalized recap operations, response projections, errors and launch tokens. Deploy the Worker before Pages. Explicit earlier contract versions are rejected before writes; there is no versioned compatibility adapter. The corrected tuning and preset-edit semantics described below remain unchanged. Existing disabled rows are not automatically restored because intent cannot be recovered from those rows.

The searchable coin catalog is projected by `scripts/build-data/build-client-registry.mjs` into `shared/data/stablecoins/coins.telegram-mini-app.generated.json`. Each slim entry carries `rank`, its 1-based position in `canonical-order.json` (the curated market-cap order); the client sorts search results and followed coins by it and never displays it as a statistic. Each entry also carries `variant` (the registry has `variantOf`, or `flags.yieldBearing` is true): the default "Largest stablecoins" list in Add coins shows base coins only, while search still finds variants. The `catalog-v2-` version prefix marks these fields. `shared/lib/telegram-mini-app-catalog.ts` combines that slim asset with the shared preset definitions and derives a content version. The slim catalog is bundled into the fingerprinted static Mini App JavaScript, so it is cached with the Pages asset instead of being returned by every signed API call. The repository does not currently define a fixed byte budget for this registry-sized artifact.

Clients advertise `mini_app_contract` and `mini_app_catalog` query parameters. A matching Worker returns `{ contractVersion, catalogVersion, stateRevision, state }`; `state` contains only viewer/subscriber/preset/subscription/health data and never the immutable catalog. A request with neither parameter remains an unversioned legacy client and receives the full-catalog state shape, without retired recap fields or operations. Query negotiation avoids adding custom request headers. The v7 client must not ship before the v7 Worker: an earlier version-aware Worker rejects v7.

Version skew returns `409 contract-version-mismatch` or `409 catalog-version-mismatch` before auth cooldown, mutation burst, analytics, or persistence writes. The client does not replay a rejected mutation. It stores only the non-identifying target-version pair in `sessionStorage` and reloads the fingerprinted static bundle at most once for that target; a repeated mismatch asks the user to close and reopen the Mini App.

## Client State And Control Semantics

The client renders only server-confirmed state and commits every control on change (switches, pickers, chips); there are no Save buttons. Results, errors, Undo and the stale-auth "Not saved: …" intent appear in one fixed bottom snackbar so they stay visible wherever the user scrolled; success hides itself, errors stay until dismissed. Undo is disabled while another save is in flight, and an edit attempted during one is reported, never dropped silently. Visible copy says "preset" (not "group") to match the landing page and `/list` and avoid confusion with Telegram group chats. Each state has at most one primary action, always in the Telegram MainButton (setup, Resume alerts, Open chat when Telegram blocks delivery, Follow SYM / Follow PRESET, Add N coins, Reopen to edit, Try again); it is rendered inline only where no MainButton exists. A mutation leaves the pressed/selected value unchanged while its request is pending, marks the initiating control busy, disables the other mutation controls, and replaces state only after a successful response. A failed mutation therefore keeps the previous confirmed value without a misleading optimistic flip or rollback animation.

Coin tuning **Default** (DEWS/safety) and **Any depeg** keep that family enabled with null tuning, and establish the per-coin override rather than suppressing inherited alerts. Default DEWS means **ALERT or higher**, not every band; default safety means all changes. Only an explicit `alertTypes: { family: false }` turns a family Off, including when the same patch carries null tuning. Bot callback token `0` remains Off and is not the Mini App domain representation of Default/Any.

`follow-preset` edits replace explicitly supplied family flags; omitted flags retain the followed preset's value (or start disabled for a new follow). The Store merges field-presence flags against the current row inside the transaction, so interleaved partial edits cannot restore omitted flags from a stale read. A non-null depeg step enables depeg unless the patch explicitly sets depeg false; disabling depeg clears its step. At least one preset family must remain enabled; use Unfollow to remove the last one. This invariant is checked against that same transaction row before any subscriber or preset write. The preset update, subscriber activity and preference-generation transition commit atomically without altering direct/local rows. Command `/subscribe` remains additive and unions families.

Bulk previews and direct-removal undo capture direct flags/overrides/tuning, raw coin snoozes, presets and preference generation in one SQL statement snapshot. A later preference write makes the generation-guarded confirmation/removal fail rather than pairing older settings with a newer generation. Undo restores snoozes from that same capture. Empty retained subscribers remain distinct from absent subscribers.

`remove-coin` also deletes a stored row whose coin has left the registry, without an undo.

Successful `forget-me` is terminal for the open client: retained state and undo are cleared, signed reads/writes and refreshes are revoked, and native Back/Settings/Main buttons are hidden and detached. Captured late callbacks cannot dispatch; only Close remains.

Every successful session read or mutation also records the response `stateRevision` and the local receive time. For an older Worker's full-state response, the client derives the same opaque revision with `telegramMiniAppStateRevision()` after excluding the bundled catalog. If a later session refresh fails, the last confirmed state stays visible but the shell enters an explicit stale mode: it shows the refresh time, disables all mutations, and requires a successful **Try again** before editing becomes available again. The opaque revision is bookkeeping and is not shown. Stale data is never silently presented as current, and a failed refresh never discards a user's readable settings.

Watcher status uses enabled global/direct/preset families, not row existence: retained empty subscribers have no enabled alerts. Indefinite pause and timed snooze suppress the active heading; timed snoozes expire at the shared client `nowSec` deadline. Delivery history remains visible independently.

Delivery health shows separate latest successful alert and command-reply clocks; neither is evidence that the other lane succeeded. Late diagnostic writes do not move these clocks backward or clear a newer failure. Equal-second failures remain visible even beside a successful reply/delivery; the full reconciliation rule is owned by [State / persistence](./telegram-architecture.md#7-state--persistence).

Stale-auth relaunch encodes the visible screen: Coin detail → `coin_<id>`, Settings → `settings`, Add coins → `setup`, anything else → `home`.

Time zone is one native picker: suggested zones (current, this device, common) then every IANA zone. Null shows "Not set (UTC)"; choosing UTC persists `"UTC"`. Quiet hours are a switch plus From/To pickers that save on change; a pick that would make start equal end is rejected in the snackbar before any request.

Quiet-hours OFF retains the saved start/end. Enabling with both hours omitted atomically reuses a valid saved window, defaulting to 22–07 only when unconfigured or invalid. Supplying hours is an explicit window update (an omitted counterpart keeps its documented default; the effective pair must still differ), distinct from an enabled-state toggle; timezone interpretation is unchanged.

## Effective Alert Source

Coin rows and Coin detail show, per live family, what will actually reach the chat, derived from the session payload with no extra reads (`familyCoverage` / `coinCoverage` in `src/app/pharoswatchbot/app/format.ts`). The helper mirrors the `/list` precedence (**per-coin > group > all stablecoins**, see [`telegram-alerts.md`](./telegram-alerts.md)) and uses the `alertOverrides` markers rather than reading every zero flag as an opt-out:

- **On**: the coin's own row enables the family.
- **On via PRESET / All stablecoins**: no own flag, and a followed preset whose `memberIds` include the coin (DEWS, depeg and safety only) or the matching All stablecoins family covers it.
- **Muted**: the family is off with its override marker set while a preset or All stablecoins is known to cover it.
- **Can't be checked**: a covering preset's `memberIds` is `null`; the client claims neither coverage nor a mute of it, and coin rows say "X can't be checked" rather than "No alerts".
- **Off**: nothing covers it.

Coin detail renders On and On via as switched on. Turning an inherited family off sends `alertTypes: { family: false }`, which writes the override marker and mutes it for that coin only; per-coin tuning pickers appear only for families the coin enables itself. Following and unfollowing a preset changes `telegram_preset_subscriptions` plus the subscriber row's activity and preference-generation markers in `telegram_subscribers`; direct/local coin rows in `telegram_subscriptions` remain unchanged.

## Auth Model

`validateTelegramMiniAppInitData` in `worker/src/telegram/mini-app/mini-app-auth.ts` owns Telegram HMAC validation and timing-safe comparison. Require signed hash, auth date and user; untrusted browser fields or launch hints are not identity. Try current bot token then configured previous token for overlap ([secret rotation](./runbooks/telegram-webhook.md#secret-rotation)); outbound sends use current token only.

Freshness windows:

- **Reads:** signed `auth_date` within 24h for session and bulk previews.
- **Writes:** signed `auth_date` within five minutes. One launch may make multiple edits with the same `initData`; no rolling refresh or one-shot replay claim is allowed. Never persist raw `initData`.
- **Expired launch is terminal on the client:** Telegram never refreshes `initData` inside a running Mini App, so any `stale-auth` (a session read past 24 hours, a write past five minutes, or a server state with `mutationBlockReason = "stale-auth"`) puts the shell in one reopen state: a "Reopen to edit" banner, and the native MainButton reads "Reopen to edit" (relaunch via `openTelegramLink` preserving current panel/coin/insight; inline button only when no MainButton exists), and a Close action calls `webApp.close()`. Edit expiry alone keeps refreshing readable state (signed reads stay valid for 24 hours), and stale-data or error banners still show beside it. Only a `stale-auth` on a session read or signed read (bulk preview) ends the session: it disables further signed reads and stops the visibility auto-refresh and Try again from resending the same `initData`, and then the reopen banner replaces every other status banner. Private-chat controls stay readable and tappable rather than greyed out; an edit attempted in this state is never sent and its intent stays visible in the snackbar ("Not saved: …") instead of being discarded.
- **Telemetry:** signed stale rejections record one aggregate event per expired `initData` and surface (keyed by the first 16 hex characters of the signed `hash` in the per-user command-cooldown cache, held for 7 days to match short-lived chat cache retention), so counts measure incidents, not client retries. Every retry still returns `401 stale-auth`; the dedupe gates only the telemetry write. Reads use `mini_app_session_invalid`; writes use `mini_app_mutation_denied`, failure `stale-auth` and normalized `mutationActionDetail`, not raw operation kind. Bulk previews record `mini_app_portability` (historical event name).
- **Burst admission:** 12 schema/signature-valid attempts per user in an anchored 30-second window beginning with first admission, not wall-clock buckets. Excess returns 429 with identical integer `retryAfterSec`/`Retry-After`. Disable writes with visible non-live countdown and one polite announcement at start/end; keep reads available and require explicit action afterward, never replay.
- **Budget retention:** burst is independent of profile ownership, domain idempotency and webhook dedupe. `/forget` deletes subscriber/watchlist state and all raw chat-keyed cache entries, including legacy burst keys, but cannot reset the remaining admission budget. D1 stores only a bot-token HMAC of user plus a short epoch, count and original window clock; the current/previous epoch lookup preserves the anchored deadline across an epoch boundary. An anonymous identity serves only that <=30-second window, never a cross-window profile identifier, and neither forgetting nor rejected attempts extends it. Expired anonymous rows have no admission authority or cross-window identity and are physically pruned by the existing daily bounded cache cleanup; this is not a 30-second physical-deletion guarantee.
- **Body/auth order:** both endpoints cap bodies at 16 KiB using declared length and bounded streams before JSON/schema/HMAC. Rejected body/JSON/schema never touches D1. [Ingress runbook](./runbooks/telegram-webhook.md#preauth-ingress-abuse-controls) owns early limiter interpretation.
- **Privacy:** exact embedded route/descendants omit Google Analytics, page views/events/Web Vitals and GA/Tag Manager CSP origins while permitting Telegram bridge; public landing retains normal configured analytics. First-party usage aggregates are signed-auth-only and identifier-free; the adoption funnel (launch campaign/placement, session-to-first-mutation latency) is retired and writes nothing. Preauth rejection writes nothing.
  The `telegram_subscribers.first_follow_at` milestone is still claimed inside the same Store mutation transaction (including bulk generation guards); off-only, snooze-only, stale/no-op and failed changes do not set it.
- **Groups:** group/supergroup/channel stay read-only, visibly directing users to `/settings@PharosWatchBot` in the group.

Theme normalization belongs to `telegram-theme.ts` / `applyTelegramTheme()`: preserve compliant host colors and minimally mix hostile colors to AA text/button `4.5:1` and controls/borders/focus `3:1`. `.pharos-mini-app` scopes semantic tokens to that palette. CSS seeds host color scheme before bridge; invalid/absent anchors clear stale inline values and retain fallback. Viewport, safe-area and focus offsets remain independent.

## BotFather Operator Checklist

BotFather-owned items (Main Mini App URL, profile launch toggle, preview screenshots, loading-screen icon, loading background color) are not reconciled by Worker code. The current configured state plus deploy-time smoke tests live in the [BotFather runbook](./runbooks/telegram-mini-app-operations.md#botfather-configuration). Verify quarterly or after a BotFather UI change.

## Debugging Workflow

Real-device inspection paths for triaging Mini App issues:

- **Telegram Desktop Beta** — `Settings → Advanced → Experimental settings → Enable webview inspecting`, then right-click → Inspect inside the Mini App for full Chrome DevTools.
- **Telegram macOS Beta** — 5-tap the Settings icon → Debug Menu → Debug Mini Apps.
- **Android USB** — Telegram Settings → double-long-press the version label → Enable WebView Debug, then attach `chrome://inspect/#devices`.
- **iOS Safari** — cable to a Mac and use Safari's Develop menu → device list.
- **Eruda toggle** — appending `?debug=eruda` to the Mini App URL loads Eruda from CDN when `NODE_ENV !== "production"`. Use this when you need an in-Telegram console without changing code. The toggle is no-op in production builds.

For incident triage, use the [complete Telegram runbook hub](./telegram-alerts.md#runbooks) rather than DevTools. Mini App-specific entry points:

- [Auth failures](./runbooks/telegram-mini-app-operations.md#auth-failures) — `mini_app_session_invalid` spikes.
- [Preset resolution failure](./runbooks/telegram-delivery.md#preset-resolution-failure) — `presetFailure` / `presetQueryFailures` rising.
- [Ingress/setup incidents](./runbooks/telegram-webhook.md#setup-state) — setup wizard does not progress.
- [Group admin gate rollback](./runbooks/telegram-webhook.md#group-admin-gate-rollback) — flipping the group admin gate from hard to soft.

## Test Fixtures

`shared/test-utils/telegram-mini-app-state.ts` owns session-state builders for frontend and shared contract tests; mutable-state fixtures omit its catalog.

Before a release that changes Mini App layout, theme, auth, or mutations, an operator verifies a real Telegram session:

1. Open a populated private session on current Telegram iOS, Android, and Desktop in light and dark appearance.
2. Visit Home, Coin detail, Add coins, Preset detail and Settings through the BackButton; use VoiceOver or TalkBack on one mobile client and keyboard-only navigation on Desktop with visible focus.
3. Repeat one mobile pass with the OS large-text setting and reduced motion enabled; rotate once and inspect top/bottom controls on a device with safe-area insets.
4. On Desktop, check browser/WebView zoom at 200% and confirm controls reflow without horizontal page scrolling or hidden focused controls.
5. Verify group read-only copy with edits disabled, and the single stale-auth reopen state (MainButton "Reopen to edit", Close, no Retry, unsaved edits shown as intent). Use a non-production test subscriber for the destructive forgotten-state check.

Record the Telegram/client version, OS/device, appearance, assistive setting, and result in the release handoff. These are operator checks; CI does not report them as automated passes.

## Mini App Launch Entrypoints

[Launch surfaces](#launch-surfaces) is the single inventory for Worker-reconciled and BotFather-owned entrypoints. [Payload scheme](#payload-scheme) owns view routing; the [BotFather runbook](./runbooks/telegram-mini-app-operations.md#smoke-tests) owns operator configuration and real-client launch tests.

## Frontend Main Page

`src/app/pharoswatchbot/page.tsx` serves public `/pharoswatchbot/` using the shared feature shell, linked from Tools and the homepage status strip. `/telegram` and descendants redirect to canonical matching paths. It explains the bot, verbatim samples for the five live families, one-tap setup, the low-noise policy (live versus daily Changes message, the per-chat daily cap, Fewer like this, quiet hours and pause), the Mini App with its screenshot carousel, public digest/community channels, a compact command card (typed-only commands collapsed) and the FAQ, which carries the reliability and privacy answers. Policy numbers in the copy (daily live-alert cap, Changes hour, live freeze threshold, dispatch cadence, alert TTL) derive from `shared/lib/telegram-delivery-policy.ts`. The command card renders every variant from `TELEGRAM_COMMAND_REFERENCE` (the BotFather registration source); `command-manual.test.tsx` fails if the page and the menu drift, and `page.test.tsx` fails if retired features (recap, launch alerts, Presets tab, export/import, retired commands) reappear in the copy or JSON-LD. Visible FAQ/setup/application metadata must agree with page copy, not become an independent behavior inventory.

The page reads `/_site-data/telegram-pulse` for public watcher counts/top follows/history only; it never calls mutating bot APIs and exposes no operational Mini App/queued-delivery counters. Unavailable pulse renders `—`, never retained counts; loading/unavailable states are named polite status regions with busy state. Samples derive verbatim from `shared/lib/telegram-alert-samples.ts`.

The recommended `pw1_landing_setup` link opens the bot's onboarding card, whose first button follows the 25 largest USD stablecoins (`usd-top25`, DEWS and depeg) in one tap; nothing is subscribed until that tap. Landing CTAs are plain `t.me` links; no click beacon or funnel attribution is recorded. Component order/layout is owned by the route, not mirrored here.

## Public Pulse Privacy And Freshness

The public pulse keeps the exact `activeWatchers` total visible by product decision, because it is the primary adoption signal on the public page. Low-cardinality supporting metrics are more sensitive while the bot is small: nonzero values below 5 are suppressed for daily new/churn/reactivation deltas, pending deliveries when available, and lifecycle-history delta fields. Suppressed fields are listed in `privacy.suppressedFields`; consumers should omit those tiles instead of rendering zero. Mini App session/mutation/denied/replay counters and first-mutation latency are no longer part of the public payload; operators read Mini App usage from `telegram_usage_daily`.

Pulse publication reuses heavy public sections on a 15-minute cadence, but only within the same UTC day.

Publication is ordered so the heavy-section reuse marker can never claim work that was not durably published: the snapshot cache write commits first, and only then does the marker advance. A failed snapshot write surfaces as an `error` outcome on the `telegram-pulse-snapshot` scheduled sidecar (with `snapshotPublished: false` and the write error preserved in the cron metadata) instead of being swallowed; a failed marker write after a successful snapshot write degrades the sidecar and leaves the marker behind so the next run recomputes the heavy sections.

`quality.status` is `partial` when a non-critical public telemetry loader failed. Absent pulse `quality` is `unknown`, never `complete`. Public copy stays generic and never includes raw D1 or provider errors; Access-gated `/api/status` keeps field-level Telegram telemetry diagnostics for operators. Unavailable telemetry takes precedence over privacy suppression: if `pendingDeliveries` cannot be loaded, the response returns `pendingDeliveries: null` and lists `pendingDeliveries` in `quality.unavailableFields`, not in `privacy.suppressedFields`.

A failed refresh keeps the retained pulse (counts, chart, dates, telemetry badge); the shared `deriveDataHealth`/`useFreshnessBoundary`/`DataHealthBanner` path ages it from `currentSnapshotAt ?? updatedAt` against `FRONTEND_API_QUERY_DESCRIPTORS.telegramPulse.producerIntervalMs` and warns only past the stale band (ADR-42); receipt time seeds only the first assessment. Each animated scalar (`activeWatchers`, `coinSubscriptions`) and its accessible text render only while the current snapshot carries a finite value absent from `quality.unavailableFields`; because `useCountUp` keeps its last display on null, the rendered output is gated too, so a partial snapshot never resurrects a prior count. Explicit zero renders. The telemetry badge describes snapshot coverage, not refresh success. Rankings/history check `quality.unavailableFields` before rows; empty placeholders require successful reads.

Freshness is split deliberately:

- `currentSnapshotAt` / `updatedAt` describe the current aggregate pulse, refreshed on the 5-minute Telegram pulse cadence.
- `lifecycleHistoryUpdatedAt` describes the latest persisted daily lifecycle snapshot. `historySource` is always `snapshot`; unavailable snapshot history is reported through `quality.unavailableFields` rather than reconstructed from current subscriber cohorts.
- `lifecycleHistoryEverySeconds=900` documents the lifecycle snapshot refresh cadence.
- Heavy public pulse sections (`topCoins` and lifecycle history) are reused for up to 15 minutes when the cached pulse is valid. The current aggregate counts still refresh on the 5-minute pulse cadence, and pending-delivery count can reuse the dispatch lane's pending-capacity snapshot.

The public chart contains at most 90 completed UTC days of persisted lifecycle snapshots. Daily subscribe, unsubscribe, and reactivation counts come from transition events captured when subscription state changes; the current partial UTC day is never presented as finalized history.

Live opt-ins include every alert family, but historical snapshot writes retain only the daily table's supported columns: reserve/freeze family counts and the all-types conjunction are not persisted. One fixed ordered column/value list drives insert, update and bindings; adding a live family does not silently expand historical storage.

Pulse snapshot publication is generation-fenced: an older build cannot replace a newer generation. Lifecycle-event/preset read failure publishes affected fields as null in `quality.unavailableFields`, never synthetic zero.
