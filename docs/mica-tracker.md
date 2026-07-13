# MiCA Compliance Tracker

**Status: shipped as part of `/compliance/`.** MiCA metadata remains the `mica` metadata extension, but the public route moved from `/mica/` to the canonical [Compliance Tracker](./compliance-page.md) at `/compliance/`. `/mica` is a 301 legacy redirect only.

The tracker maps assessed stablecoins to their standing under the EU Markets in Crypto-Assets Regulation (MiCA, Regulation (EU) 2023/1114): authorization tier, token type (EMT vs ART), competent authority, the authorized issuer entity, and per-coin register references. Missing `mica` metadata means "not assessed", not out-of-scope or non-compliant. It is an **informational tracking surface with sourced links, not legal advice** — see [Legal framing](#legal-framing-non-goals).

The data foundation already half-exists: 241 coins carry a `jurisdiction` block, EU regulators (ACPR, DNB, BaFin, MFSA, AMF) and 9 `"EMI (MiCA)"` licenses appear as free text, and 23 EUR-pegged coins plus the major USD coins are in scope. This feature **structures and classifies** that existing free text — it is not a green-field data collection effort.

---

## Architectural keystone

MiCA status is **static editorial metadata, not pipeline data**. It lives in the per-coin JSON files (`shared/data/stablecoins/coins/*.json`), is bundled into the client registry at build, and renders client-side exactly like `/screener`.

**No Worker endpoint, no D1 migration, no cron job, no API hook, no `next.config.ts` change.** This is the decision that keeps complexity at Medium. Every Worker/connection-pool/cache gotcha in `CLAUDE.md` is out of scope for this feature.

---

## Schema

A dedicated `mica` object on `StablecoinMeta`, not an overload of `jurisdiction` (which stays as the generic `{ country, regulator?, license? }` summary). A dedicated object is the smallest change that captures MiCA's required fields without speculative regime configurability.

GENIUS is now tracked as a dedicated sibling `genius?: GeniusProfile`, not by migrating MiCA into a generic regulatory array. Keep `mica` dedicated because MiCA has regime-specific fields and an existing curated backfill.

### Types — `shared/types/core.ts`

MiCA metadata is implemented as `mica?: MicaProfile` on `StablecoinMeta`. Status/type/auth enums and the `MicaProfile` interface live in `shared/types/core.ts`, following the `as const` value-list + derived-type pattern used by `MECHANISM_ARCHETYPE_VALUES`, `CHAIN_TIER_VALUES`, etc.

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
  references?: StablecoinLink[]; // ESMA/EBA/NCA register links (required for any non-out-of-scope status)
}
```

`StablecoinMeta` includes the profile alongside `jurisdiction?`:

```ts
  mica?: MicaProfile;
```

### Zod — `shared/types/stablecoin-meta-schemas.ts`

Zod validation lives in `shared/types/stablecoin-meta-schemas.ts` and mirrors the `JurisdictionSchema` pattern, `.strict()`. A cross-field rule enforces sourcing for any non-out-of-scope status:

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
  if (mica.status === "out-of-scope") {
    for (const field of ["tokenType", "authorizationType", "competentAuthority", "authorizedEntity"] as const) {
      if (mica[field] != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mica.out-of-scope rows cannot carry in-scope classification fields",
          path: [field],
        });
      }
    }
  }

  if (mica.status !== "out-of-scope" && (mica.references?.length ?? 0) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mica.status requires at least one source reference unless it is 'out-of-scope'",
      path: ["references"],
    });
  }
});
```

### Wiring — `shared/lib/stablecoins/schema.ts`

`StablecoinMetaAssetSchema` wires MiCA through next to `jurisdiction: JurisdictionSchema.optional()`:

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
| `out-of-scope` | Not offered to the public or admitted to trading in the EU, or reviewed legal/source evidence indicates the token is outside EMT/ART issuer authorization requirements (for example, no identifiable issuer for Titles II-IV). | Default for non-EU-marketed coins; sourced issuer-scope analysis for edge cases |

Leave `mica` **undefined** for coins not yet assessed — the page distinguishes "not assessed" (no row / muted) from `out-of-scope` (explicitly reviewed). This bounds the backfill: only researched coins assert a status.

`out-of-scope` rows are explicit assessments, but they must not carry in-scope MiCA classification fields such as `tokenType`, `authorizationType`, `competentAuthority`, or `authorizedEntity`. Use those fields only when the row is asserting an EMT/ART posture inside the MiCA status model.

### Token type (`tokenType`)

- **EMT (E-money token):** references a single official currency. Most EUR and USD fiat-backed stablecoins are EMTs.
- **ART (Asset-referenced token):** references a basket or other value (multi-currency, commodity, or mixed). Rare in the tracked set.

### MiCA timeline anchors (for copy / the optional timeline strip)

- **30 Jun 2024** — Titles III (ARTs) & IV (EMTs) apply; issuer rules live with **no grandfathering for issuance**.
- **30 Dec 2024** — Title V (crypto-asset service providers) applies.
- **~1 Jul 2026** — end of the longest national CASP transitional ("grandfathering") windows; the "full application" milestone. Note this window covers **service providers/venues**, not issuers — status copy must not imply issuers are grandfathered.

Per-coin `significant` follows EBA designation of significant EMTs/ARTs (threshold-based; EBA-supervised).

---

## Page contract — `/compliance/`

Model on `/screener` (client-only, bundled registry, URL-encoded filters). No API hooks needed for the MiCA columns themselves; reuse existing hooks only if surfacing live supply/peg context alongside.

**Route shape:**

- `src/app/compliance/page.tsx` — server shell via `createClientFeaturePage()`; metadata, breadcrumb, static intro + FAQ.
- `src/app/compliance/client.tsx` — filters + table, reads the bundled registry through `@shared/lib/stablecoins/client-registry`.
- `src/app/compliance/model.ts` — `buildComplianceViewModel()` mapping registry rows → MiCA and GENIUS table rows, filtering out coins with no regime metadata and frozen/pre-launch assets from the main table.
- `src/app/compliance/loading.tsx`, `error.tsx` — match the `/liquidity` skeleton/boundary pattern.
- `public/_redirects` — legacy `/mica` traffic redirects to `/compliance/`.

**Columns:** coin · regime (MiCA / GENIUS) · status badge · pathway / type (EMT/ART, authorizationType, `significant` badge) · authority · issuer entity · [reserve disclosure — GENIUS rows only] · sources.

**Filters (URL-encoded, via `useUrlFilters`):** `regime`, `status`, `type`, `peg`, and free-text search as `q`. Example: `/compliance/?regime=mica&status=authorized&peg=EUR`. The client also accepts legacy `tokenType` and `pegCurrency` query keys as read-only aliases.

**Status presentation:** MiCA-specific labels, descriptions, and static Tailwind badge classes live in `shared/lib/mica.ts`. Keep the status vocabulary in `shared/types/core.ts`; do not duplicate labels or colors inside route components.

**Navigation:** `src/lib/nav-config.ts` includes `/compliance/` in the `NAV_GROUPS` entry keyed `"risk"` with the `Landmark` icon and description "MiCA authorization and GENIUS implementation status across tracked stablecoins". The mobile drawer, desktop top nav, legacy sidebar, and command palette auto-index from `NAV_GROUPS`.

**Detail-page surfacing:** `src/components/key-info-card.tsx` renders a MiCA/Historical MiCA badge in the jurisdiction block, linking to `/compliance/?regime=mica`. It reuses the established badge styling; no new component is required.

**Static export / SEO:** route is statically pre-rendered and included in the sitemap; run `npm run seo:check` after crawlability changes. No `next.config.ts` change.

Verify: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run seo:check`, plus a page render smoke test.

---

## Optional: timeline integration

Low-cost reuse, not required for MVP:

- A global "key MiCA dates" strip on `/compliance/` using the anchors above.
- Per-coin regulatory milestones via the **existing** `LaunchMilestone` `type: "regulatory"` (`LAUNCH_MILESTONE_TYPE_VALUES` in `core.ts`) and chart-annotation `"regulatory"` type, surfaced in the `/timeline/` feed ([tape-page.md](./tape-page.md)).

No new infrastructure — these primitives already exist.

---

## Data sourcing & maintenance

This is the dominant cost, not the code.

- **Sources of truth:** ESMA register of authorized entities; EBA registers of EMT/ART issuers; national authority registers (ACPR REGAFI, BaFin, DNB/AFM, MFSA, CBI, Bank of Lithuania).
- **Mapping is manual:** token → issuer entity → authorization is not cleanly API-able. Treat like the existing `reserve-research` / `resilience-classify` editorial workflows.
- **Backfill scope:** ~30–60 coins warrant real research (the EUR coins + major EU-traded USD coins). Forty tracked coins currently carry structured `mica` metadata: 16 `authorized`, 18 `non-compliant`, 2 `pending`, and 4 explicitly reviewed `out-of-scope` rows. The other 371 tracked coins are unassessed, not implicitly out of scope. Start refreshes from the coins already mentioning MiCA and the 9 with `"EMI (MiCA)"` licenses.
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

## Maintenance

MiCA labels, descriptions, and badge classes live in `shared/lib/mica.ts`; status values remain in `shared/types/core.ts`. Ongoing work is data refresh through the `mica-research` skill plus normal route/build checks.

- Data refresh: update per-coin `mica` blocks with sourced register references, then run `npm run check:stablecoin-data`.
- Route verification: run `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run seo:check` when route/UI behavior changes.
- Timeline layer remains optional and can use existing `LaunchMilestone` `type: "regulatory"` and TAPE primitives.
- **Not a methodology-version bump:** MiCA status is a tracked attribute, not a score. Assignment criteria live in this doc, not in `/methodology` versioning.

---

## Legal framing & non-goals

- The tracker is **informational and sourced**, explicitly **not legal advice**; surface this on the page. Require a `references` link before asserting `authorized`.
- Be precise that the mid-2026 grandfathering window covers **CASPs/venues**, while EMT/ART **issuer** rules have applied since June 2024 with no issuance grandfathering — copy must not overclaim.
- **Non-goals:** no automated regulatory scraping; no per-coin compliance scoring; no extra regulatory regimes beyond the dedicated MiCA and GENIUS profile models already surfaced on `/compliance/`.
