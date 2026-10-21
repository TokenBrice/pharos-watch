# Privacy Page

Public static `/privacy/` describes processing elsewhere in the product; it fetches no private data. `src/app/privacy/page.tsx` owns canonical metadata and visible Last updated date; advance it for substantive policy changes. Keep footer/sitemap discovery and indexability. User-understandable categories, not an exhaustive table inventory, are the policy structure.

## Data Categories

### Website analytics

`src/lib/analytics.ts` owns the host/path/event gate. GA4 requires configured `NEXT_PUBLIC_GA_ID` and production `pharos.watch`. Operator hosts/routes (`/admin/`, `/admin-api/` and descendants), Pages previews and Telegram Mini App receive no bootstrap, page views, custom events or Web Vitals. Recheck browser location for delayed custom callbacks after navigation.

Explicitly configured localhost/127.0.0.1/[::1] is a test-only exception; use a test measurement ID. No other suffix/preview is allowed. Visible policy describes cookies, retention, hosting and actual typed event catalog, never hypothetical telemetry.

Search events originate from manual input, not initial URL/history. They send page label/query length, never raw search text; clearing/navigation cancels pending events. Navigation sends bounded chrome/group/internal href without query string; palette selection sends query length and result kind/section/rank, zero-result events length only. Raw palette text is never sent. This does not strip query strings from ordinary page-view URLs.

Web Vitals retain document-lifetime meaning and current allowed path attribution; client navigation is not a new document measurement. Callback/debounce implementation belongs to the source, not this policy.

### Browser-local preferences

There is no website account. Optional supporter-claim wallet interaction is the only wallet connection. Browser state includes shortcuts, portfolio, shared watchlist, Picker dismissal/session recovery, table/show-work/motion/history/Timeline preferences. Feature owners define exact keys: [Homepage](./homepage.md), [Portfolio](./portfolio-page.md#persistence-and-sharing), [Picker](./screener-page.md#browser-storage). Portfolio/shortcut state is not sent to API; shared snapshots are separate server-side storage.

Picker tab-session recovery retains completed answers and their save time, not the generated shortlist. Restoring answers evaluates current data; server-side share snapshots retain frozen output separately.

The homepage retains a bounded IndexedDB envelope of public market/PSI/incident evidence, with whole-envelope schema/methodology version admission and per-lane producer-age admission ([Homepage](./homepage.md#browser-state)). Detail pages separately retain compact public live summaries for at most 20 coin IDs in least-recently-used order, without URLs, visit timestamps or user identifiers. Both restore only after hydration as dated, labelled retained display evidence, never a persisted query cache, and expire under the existing 72-hour fallback ceiling. Neither envelope is sent to the API; browser site-data clearing removes them, and expired evidence is ignored even if its row remains on disk. Detail schema/projection changes rotate its envelope version; market projection changes rotate the homepage envelope version.

### Feedback and API access

Feedback contact handles may be published in GitHub issues; disclose that before submission. Partner/lost-key/removal requests use private Telegram/X constants from `shared/lib/public-api-contract.ts`, with request messages deleted after issuance/rotation. No new self-serve email requests or Resend verification are accepted. Existing self-serve credentials expire on their established schedule; legacy email/request metadata remains private until coordinated cleanup. Rate identifiers are hashed, never raw IP.

Supporter claims store signing wallet, token prefix and claim time in `api_key_donor_claims` plus key row/name and usage metadata. Issuance audit records tier, not address. Wallet-linked credentials are personal data processed for the requested perk. Signature/plaintext token never persist or enter logs. Unsaved token is temporary browser memory across internal navigation, cleared on copy/acknowledgment/unload, never local/session storage. Wallets stay outside request telemetry/structured logs; log outcome codes only.

These records have no automatic expiry. Deactivation alone leaves wallet-bearing key name/usage. Private removal requests follow [admin reference](./api-reference-admin.md) to deactivate and delete key/usage/audit rows. Wallet/prefix/time remain in the claim fence against second issuance; removing that fence requires explicit reissuance decision. This is partial erasure, not all-wallet-record deletion; public donation ledger is independent and unaffected. [API route contract](./api-page.md#supporter-key-claim-contract) owns claim/recovery behavior.

### Stablecoin Picker snapshots

Share artifacts are server-recomputed from allowlisted answers/canonical data. They include normalized input/output, methodology/version binding, dataset hash/provenance, no account/wallet/raw IP/fingerprint. Anyone with URL can read them.

Unread artifacts expire after 90 days. Successful read attempts five-year retention extension; failure does not fail read and later reads can retry. Stored extension metadata prevents sliding expiry. Keyed IP-derived quotas exist in short-lived limiter/D1, not artifact body. [Snapshot sharing](./screener-page.md#snapshot-sharing), shared schema and Pages Function own payload/verification/quota details; do not copy a second matrix here.

### Telegram alerts and Mini App

Telegram processing includes subscriber identity/settings, follows/presets, quiet/snooze state, short-lived command state, delivery queues/outcomes/audit, retained records from the retired personalized recap feature, authenticated diagnostics and identifier-free aggregate adoption/usage counters.

[Telegram architecture schema-purpose map](./telegram-architecture.md#d1-schema) owns storage categories; active Worker migrations are DDL authority. Durable follows remain while configured; empty inactive profiles may prune under runtime policy. Personalized recap scheduling and delivery are removed, but existing preferences/targets remain for audit and rollback evidence until separately authorized forward-only schema cleanup after the 90-day evidence window and rollback floor close. Existing target outcomes retain their 30-day sent/skipped and 90-day cancelled/expired/unknown/permanent-failure policy; `/forget` still removes chat-attributable records immediately. Runtime retention/inactive cleanup owns short-lived and operational category lifecycles.

Mini App validates signed initData but stores neither raw value nor hash. [Mini App](./telegram-mini-app.md) owns mutation freshness, read/session portability, cooldown and aggregate telemetry. General Telegram logs use allowlisted low-cardinality fields; chat-specific investigation stays in authenticated D1/admin diagnostics, not raw general-log identifiers.

Inline-query status cards and their query/selection counters are retired. Unsolicited inline updates follow the [unsupported-update ingress contract](./telegram-architecture.md#1-ingress) without new usage telemetry; historical identifier-free aggregates retain their ordinary retention policy.

## Update Rules

Change visible policy and this owner together for processing/storage/retention changes, plus the closest feature owner. Preserve host/path gates, raw-query/token exclusions and erasure limitations. Migrations/store/cleanup modules own implementation, not a second database inventory in policy prose.
