# MiCA Compliance Tracker

**Status: shipped.** The `/mica/` route and the `mica` metadata extension are live. This document began as the pre-build spec and now serves as the as-built reference; the implementation follows it, with two deltas: the status label/color map lives in a dedicated `shared/lib/mica.ts` (not `shared/lib/classification.ts`), and the initial register-verified backfill covers 24 coins (expandable via the `mica-research` skill).

The tracker maps every tracked stablecoin to its standing under the EU Markets in Crypto-Assets Regulation (MiCA, Regulation (EU) 2023/1114): authorization tier, token type (EMT vs ART), competent authority, the authorized issuer entity, and per-coin register references. It is an **informational tracking surface with sourced links, not legal advice** — see [Legal framing](#legal-framing).

The data foundation already half-exists: 225 coins carry a `jurisdiction` block, EU regulators (ACPR, DNB, BaFin, MFSA, AMF) and `"EMI (MiCA)"` licenses appear as free text, and ~23 EUR-pegged coins plus the major USD coins are in scope. This feature **structures and classifies** that existing free text — it is not a green-field data collection effort.

---

## Architectural keystone

MiCA status is **static editorial metadata, not pipeline data**. It lives in the per-coin JSON files (`shared/data/stablecoins/coins/*.json`), is bundled into the client registry at build, and renders client-side exactly like `/screener`.

**No Worker endpoint, no D1 migration, no cron job, no API hook, no `next.config.ts` change.** This is the decision that keeps complexity at Medium. Every Worker/connection-pool/cache gotcha in `CLAUDE.md` is out of scope for this feature.

---

## Schema

A dedicated `mica` object on `StablecoinMeta`, not an overload of `jurisdiction` (which stays as the generic `{ country, regulator?, license? }` summary). A dedicated object is the smallest change that captures MiCA's required fields without speculative regime configurability.

> **Deferred alternative (do not build now):** a generic `regulatory: RegulatoryRegime[]` array supporting MiCA + future regimes (US GENIUS Act, MAS, HKMA). The free-text data already hints at latent demand (SEC, OCC, NYDFS, MAS, FINMA, HKMA all appear), but YAGNI for a single-regime ask. Refactor `mica` → `regulatory[]` only when a second regime is actually tracked.

### Types — `shared/types/core.ts`

Add near the existing `Jurisdiction` interface (`core.ts:114`), following the `as const` value-list + derived-type pattern used by `MECHANISM_ARCHETYPE_VALUES`, `CHAIN_TIER_VALUES`, etc.

```ts
export const MICA_STATUS_VALUES = [
  "authorized",     // EMI / credit-institution authorization in effect for the EMT/ART
  "pending",        // application filed with a competent authority, awaiting decision
  "transitional",   // relying on a national CASP grandfathering window (sunsets ~mid-2026)
  "non-compliant",  // in EU scope, no authorization path; delisted or restricted on EU venues
  "out-of-scope",   // not offered to the public or admitted to trading in the EU
] as const;
export type MicaStatus = (typeof MICA_STATUS_VALUES)[number];

export const MICA_TOKEN_TYPE_VALUES = ["EMT", "ART"] as const; // e-money token vs asset-referenced token
export type MicaTokenType = (typeof MICA_TOKEN_TYPE_VALUES)[number];

export const MICA_AUTHORIZATION_TYPE_VALUES = ["emi", "credit-institution"] as const;
export type MicaAuthorizationType = (typeof MICA_AUTHORIZATION_TYPE_VALUES)[number];

export interface MicaProfile {
  status: MicaStatus;
  tokenType?: MicaTokenType;
  authorizationType?: MicaAuthorizationType;
  competentAuthority?: string;   // e.g. "ACPR" — the supervising national authority
  authorizedEntity?: string;     // legal issuer entity named on the authorization
  significant?: boolean;         // EBA-supervised "significant" EMT/ART
  references?: StablecoinLink[]; // ESMA/EBA/NCA register links (required to assert "authorized")
}
```

Then add to the `StablecoinMeta` interface (alongside `jurisdiction?`):

```ts
  mica?: MicaProfile;
```

### Zod — `shared/types/stablecoin-meta-schemas.ts`

Mirror the `JurisdictionSchema` pattern (`stablecoin-meta-schemas.ts:90`), `.strict()`. A cross-field rule enforces sourcing for the strongest claim:

```ts
export const MicaProfileSchema: z.ZodType<MicaProfile> = z.object({
  status: z.enum(MICA_STATUS_VALUES),
  tokenType: z.enum(MICA_TOKEN_TYPE_VALUES).optional(),
  authorizationType: z.enum(MICA_AUTHORIZATION_TYPE_VALUES).optional(),
  competentAuthority: z.string().min(1).optional(),
  authorizedEntity: z.string().min(1).optional(),
  significant: z.boolean().optional(),
  references: z.array(StablecoinLinkSchema).optional(),
}).strict().superRefine((mica, ctx) => {
  if (mica.status === "authorized" && (mica.references?.length ?? 0) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mica.status 'authorized' requires at least one register reference",
      path: ["references"],
    });
  }
});
```

### Wiring — `shared/lib/stablecoins/schema.ts`

Add one line to `StablecoinMetaAssetSchema` next to `jurisdiction: JurisdictionSchema.optional()` (`schema.ts:154`):

```ts
  mica: MicaProfileSchema.optional(),
```

Verify: `npm run check:stablecoin-data` and the registry tests stay green.

---

## Status criteria

Editorial assignment rules. Each non-`out-of-scope` status should carry at least one `references` link to the source that justifies it.

| Status | Assign when | Source of truth |
| --- | --- | --- |
| `authorized` | Issuer holds an in-effect EMI or credit-institution authorization for this token, listed on a competent-authority / ESMA register. **Requires a `references` link.** | ESMA register; EBA EMT/ART issuer registers; national registers (e.g. ACPR REGAFI, BaFin, DNB) |
| `pending` | Application filed with a competent authority; decision outstanding. | Issuer disclosure + authority filing |
| `transitional` | Offered/traded on EU venues under a member-state CASP grandfathering window (no issuer authorization yet). | National transitional-regime notices |
| `non-compliant` | In EU scope but no authorization and no transitional cover; delisted or restricted on EU venues. | Exchange delisting notices, issuer statements |
| `out-of-scope` | Not offered to the public or admitted to trading in the EU. | Default for non-EU-marketed coins |

Leave `mica` **undefined** for coins not yet assessed — the page distinguishes "not assessed" (no row / muted) from `out-of-scope` (explicitly reviewed). This bounds the backfill: only researched coins assert a status.

### Token type (`tokenType`)

- **EMT (E-money token):** references a single official currency. Most EUR and USD fiat-backed stablecoins are EMTs.
- **ART (Asset-referenced token):** references a basket or other value (multi-currency, commodity, or mixed). Rare in the tracked set.

### MiCA timeline anchors (for copy / the optional timeline strip)

- **30 Jun 2024** — Titles III (ARTs) & IV (EMTs) apply; issuer rules live with **no grandfathering for issuance**.
- **30 Dec 2024** — Title V (crypto-asset service providers) applies.
- **~1 Jul 2026** — end of the longest national CASP transitional ("grandfathering") windows; the "full application" milestone. Note this window covers **service providers/venues**, not issuers — status copy must not imply issuers are grandfathered.

Per-coin `significant` follows EBA designation of significant EMTs/ARTs (threshold-based; EBA-supervised).

---

## Page contract — `/mica/`

Model on `/screener` (client-only, bundled registry, URL-encoded filters). No API hooks needed for the MiCA columns themselves; reuse existing hooks only if surfacing live supply/peg context alongside.

**Route shape:**

- `src/app/mica/page.tsx` — server shell via `createClientFeaturePage()`; metadata, breadcrumb, static intro + FAQ. (frontend agent)
- `src/app/mica/client.tsx` — filters + table, reads the bundled registry through `@shared/lib/stablecoins/client-registry`. (frontend agent)
- `src/app/mica/model.ts` — `buildMicaViewModel()` mapping registry rows → table rows, filtering out coins with no `mica`. (frontend agent)
- `src/app/mica/loading.tsx`, `error.tsx` — match the `/liquidity` skeleton/boundary pattern.

**Columns:** coin · MiCA status badge · token type (EMT/ART) · competent authority · authorized entity · `significant` marker · register link.

**Filters (URL-encoded, via `useUrlFilters`):** `status`, `tokenType`, `pegCurrency`, free-text search. Example: `/mica/?status=authorized&peg=EUR`.

**Status color tokens:** add to the classification color set (`shared/lib/classification.ts`) rather than defining locally — `authorized` → healthy/green, `pending`/`transitional` → warning/amber, `non-compliant` → danger/red, `out-of-scope` → muted. (See `CLAUDE.md`: classification labels/colors are centralized.)

**Navigation:** add one `NavItem` to `NAV_GROUPS` in `src/lib/nav-config.ts`, most naturally under the `monitor` (MONITOR) group, e.g. `{ href: "/mica/", label: "MiCA Tracker", icon: ScrollText | <new>, description: "EU MiCA authorization status across tracked stablecoins" }`. The sidebar and command palette auto-index from `NAV_GROUPS`.

**Detail-page surfacing:** add a MiCA status badge to `src/components/key-info-card.tsx` next to the existing jurisdiction badges (`key-info-card.tsx:342`). Reuses the established badge styling; no new component required.

**Static export / SEO:** route is statically pre-rendered; add to sitemap and run `npm run seo:check`. No `next.config.ts` change.

Verify: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run seo:check`, plus a page render smoke test.

---

## Optional: timeline integration

Low-cost reuse, not required for MVP:

- A global "key MiCA dates" strip on `/mica/` using the anchors above.
- Per-coin regulatory milestones via the **existing** `LaunchMilestone` `type: "regulatory"` (`core.ts:220`) and chart-annotation `"regulatory"` type, surfaced in the `/timeline/` feed ([tape-page.md](./tape-page.md)).

No new infrastructure — these primitives already exist.

---

## Data sourcing & maintenance

This is the dominant cost, not the code.

- **Sources of truth:** ESMA register of authorized entities; EBA registers of EMT/ART issuers; national authority registers (ACPR REGAFI, BaFin, DNB/AFM, MFSA, CBI, Bank of Lithuania).
- **Mapping is manual:** token → issuer entity → authorization is not cleanly API-able. Treat like the existing `reserve-research` / `resilience-classify` editorial workflows.
- **Backfill scope:** ~30–60 coins warrant real research (the ~23 EUR coins + major EU-traded USD coins). The remaining ~330 are `out-of-scope` or left unassessed. Start by normalizing the ~24 coins already mentioning MiCA and the 9 with `"EMI (MiCA)"` licenses into structured `mica`.
- **Maintenance:** statuses change as authorizations are granted/refused and venues delist. Recommend a `mica-research` skill (modeled on `reserve-research`) for periodic refresh against the registers.

### Worked reference examples (verify before entry)

| Coin | Likely status | tokenType | Authority / entity |
| --- | --- | --- | --- |
| EURC / USDC (Circle) | `authorized` | EMT | ACPR (France), Circle EMI |
| EURCV (SG-FORGE) | `authorized` | EMT | ACPR (France) |
| EURQ / USDQ (Quantoz) | `authorized` | EMT | DNB (Netherlands) |
| USDT (Tether) | `non-compliant` | EMT (scope) | No EMT authorization pursued; EU venue delistings |

These illustrate the model only — confirm each against the ESMA/EBA/NCA registers at data-entry time.

---

## Phased plan

1. **Schema + backfill.** Add `MicaProfile` types + Zod + schema wiring; normalize the ~24–30 obvious coins. → verify: `npm run check:stablecoin-data`, registry tests.
2. **`/mica/` page + nav + detail badge.** Build the route on the screener pattern, register nav, add the `key-info-card` badge, add status colors to `classification.ts`. → verify: `npm run build`, `npm run lint`, `npm run typecheck`, `npm run seo:check`.
3. **Timeline layer (optional).** Key-dates strip + per-coin `regulatory` milestones via existing primitives.
4. **Maintenance skill (optional).** `mica-research` for ongoing refresh.

---

## Docs to update (per `CLAUDE.md`)

- [about-page.md](./about-page.md) — new tracked data category + data sources.
- [agent-task-router.md](./agent-task-router.md) — extend the *Stablecoin metadata* family (schema + page).
- [classification.md](./classification.md) — if/when status colors are tokenized.
- [README.md](./README.md) — register this doc and the route once built.
- **Not a methodology-version bump:** MiCA status is a tracked attribute, not a score. Assignment criteria live in this doc, not in `/methodology` versioning.

---

## Legal framing & non-goals

- The tracker is **informational and sourced**, explicitly **not legal advice**; surface this on the page. Require a `references` link before asserting `authorized`.
- Be precise that the mid-2026 grandfathering window covers **CASPs/venues**, while EMT/ART **issuer** rules have applied since June 2024 with no issuance grandfathering — copy must not overclaim.
- **Non-goals:** no automated regulatory scraping; no per-coin compliance scoring; no second regulatory regime (US/Asia) in this iteration.
