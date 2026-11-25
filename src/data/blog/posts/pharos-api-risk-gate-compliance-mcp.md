The Pharos web app is free and stays free. The public API exists for the teams that want the same data inside their own software: vault risk engines, DEX frontends, compliance pipelines, treasury desks, and coding agents.

Running that infrastructure is not free. Multi-chain RPC access, historical archive queries, scheduled cron syncs, and D1 storage carry real monthly bills, all listed in the open on the [funding page](/funding/). Community donations and in-kind infrastructure sponsorships carried Pharos through its first year, and they remain welcome. Reaching durable self-sustainability requires commercial revenue from the teams that run production products on top of our feeds.

Today we are publishing four new API capabilities built directly around how production teams integrate Pharos, alongside clearer plan boundaries, prepaid billing options, and a refreshed [API Access page](/api/).

## What changed in access and pricing

Every public API key now maps to an explicit plan with published per-minute limits, monthly quotas, and endpoint entitlements. Monthly request quotas are counted per UTC calendar month and take effect on January 1, 2027.

- **No key:** Safety Score grades (`/api/safety-grades`), the dependency graph (`/api/dependency-graph/v1`), modeled dependency scenarios (`/api/dependency-scenarios/v1`), embeddable SVG Safety Badges (`/api/badge/:id.svg`), and the [public MIT dataset downloads](/api/reference/#public-datasets).
- **Supporter key:** personal, non-commercial access for wallets donating $10 or more in qualifying A or B rated stablecoins, buying 30 days per $10 donated. Limits are 10 requests per minute and 100,000 requests per month across core read endpoints and the contract resolver.
- **Free partner key ($0):** narrowed to non-commercial open-source public goods and academic research with attribution. Limits are 60 requests per minute and 500,000 requests per month across core read endpoints and the contract resolver.
- **Commercial key ($250/month):** 120 requests per minute and 1,000,000 requests per month across every endpoint, including the Compliance API, unified Risk-Gate, and stateless MCP server. Teams can prepay quarterly at $675 (10% off) or annually at $2,500 (two months free), paid in stablecoins to the published funding addresses. A 14-day evaluation key is available on request.
- **Institutional key (from $1,000/month or $10,000/year):** 600 requests per minute and 5,000,000 requests per month by default, with higher limits on request, priority integration help, and custom coverage onboarding.

One change deserves to be stated plainly. The supporter key monthly quota published on November 20, 2026 was 200,000 requests per month. Before monthly enforcement starts on January 1, 2027, that limit moves to 100,000 requests per month for every supporter key, with no grandfathered 200,000 tier. Giving notice today leaves more than the 30-day notice window committed in the [API terms](/api/terms/).

Three new commercial surfaces (Compliance, Risk-Gate, and MCP) require a Commercial or Institutional plan. Calling them with a Supporter or Free partner key returns `403` with `reason: "plan_upgrade_required"`. Those `403` responses count against the per-minute rate limiter so callers cannot hammer gated paths, and they do not consume monthly quota.

## Four new integration surfaces

### 1. Compliance API (`/api/compliance` and `/api/compliance/:id`)

Regulatory teams and European or U.S. venues have been reading our [Compliance tracker](/compliance/) by hand. It is now a structured, queryable API covering 402 reviewed stablecoin dossiers: 294 under EU MiCA and 356 under the U.S. GENIUS Act.

Callers can filter `/api/compliance` by `regime`, `micaStatus`, `geniusStatus`, `tokenType` (`EMT` or `ART`), `peg`, or `includePreLaunch`, or fetch one asset directly at `/api/compliance/:id`. Every response includes the current statutory rulemaking state for the GENIUS Act alongside explicit `not-reviewed` nulls where an asset has not been assessed under a given regime. Unreviewed never becomes a silent pass or fail.

### 2. Contract Resolver (`/api/resolve`)

Most production systems start from an on-chain token address, not a Pharos slug. `/api/resolve` maps 2,017 tracked deployments across 125 chains to canonical Pharos identities and links straight into compliance, risk-check, detail, and summary routes.

It accepts canonical chain names, common aliases, numeric EVM chain IDs, and CAIP-2 `eip155:<id>` strings. You can look up a single `(chain, address)` pair, pass up to 50 `chain:address` tuples in one batch call, inspect every chain where a raw address appears (flagging cross-chain coin collisions explicitly via `ambiguousCoin`), or resolve reverse deployments from a canonical ID or CoinGecko ID. Because resolving addresses is a shared prerequisite for every integration, `/api/resolve` is open to all authenticated API keys, including Supporter and Free partner plans.

### 3. Unified Risk-Gate (`/api/risk-check`)

Vault allocators, lending curators, and DEX routers previously had to join six or seven endpoints and reconcile separate freshness clocks to decide whether an asset still passes their collateral policy.

`GET /api/risk-check` collapses that fan-out into a single call accepting up to 25 assets by canonical ID (`ids`) or `chain:address` (`contracts`). Each asset block joins Safety Score grade, overall score, and Backing/Exit/Control pillar scores; DEWS stress score and band; live peg price, deviation, and active depeg event; Depeg Duration Resolver outlook when a depeg is live; DEX liquidity score and TVL; redemption backstop route and capacity; freeze controls; and MiCA/GENIUS compliance summary. Every underlying dataset keeps its own freshness verdict and explicit `unavailableReason` if its upstream cache is held or stale.

### 4. Stateless MCP (`/api/mcp`) and Embeddable SVG Badges (`/api/badge/:id.svg`)

Coding assistants and research agents can now talk to Pharos directly over the Model Context Protocol without running a local proxy server. `POST /api/mcp` speaks stateless Streamable HTTP JSON-RPC 2.0 using the same `X-API-Key` header as the REST API and exposes seven read-only tools: `resolve_stablecoin`, `get_risk_check`, `get_compliance`, `get_safety_report_card`, `get_depeg_events`, `get_stress_signals`, and `get_stablecoin_reserves`. Copyable setup snippets for Cursor, VS Code, Claude Code, and Claude Desktop live in the [integration previews on `/api/`](/api/#integration-preview).

On the no-key side, `GET /api/badge/:id.svg` serves pure presentation-attribute SVG Safety Score badges (`style=flat|card`, `theme=dark|light`) with wildcard CORS and strict `default-src 'none'` CSP, ready to embed in GitHub READMEs, documentation, and protocol UIs. If a Safety Score publication is held, stale, or unavailable, the badge returns an uncached neutral `Unavailable` SVG rather than showing stale numbers or breaking third-party `<img>` tags.

We also upgraded the machine-readable tooling around the API. `openapi.json` now publishes contract version `2026-11`, `403 plan_upgrade_required` contracts, parameter examples, and schema-validated response examples across all 46 response schemas, and the Postman collection ships with saved `200 OK` responses on every request.

## What does not change

The core independence rule stays untouched. Paying for a Commercial or Institutional API key buys data access, throughput, and integration support. It never buys a rating, a listing, a review queue jump, or a softer risk score. Every stablecoin on Pharos continues to be evaluated under the same public methodologies documented on [About](/about/) and in the [API Reference](/api/reference/).

The public dashboard, free keyless Safety Score grades, dependency graph, modeled scenarios, and MIT-licensed dataset snapshots remain open without a key. Existing supporter keys keep working through their paid term, under the 100,000 requests per month volume above and the same wallet-signed claim flow.

If your team wants a 14-day Commercial evaluation key or wants to map out an Institutional integration, inspect the sample responses on [/api/](/api/) and message [@TokenBrice on Telegram](https://t.me/TokenBrice) or [@PharosWatch on X](https://x.com/PharosWatch).

See you at the lighthouse. 🗼

/- TokenBrice
