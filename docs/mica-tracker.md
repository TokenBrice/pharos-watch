# MiCA Compliance Tracker

**Status: shipped as part of `/compliance/`.** MiCA metadata remains the `mica` metadata extension, but the public route moved from `/mica/` to the canonical [Compliance Tracker](./compliance-page.md) at `/compliance/`. `/mica` is a 301 legacy redirect only.

The tracker maps assessed stablecoins to their standing under the EU Markets in Crypto-Assets Regulation (MiCA, Regulation (EU) 2023/1114): authorization tier, token type (EMT vs ART), competent authority, the authorized issuer entity, and per-coin register references. Missing `mica` metadata means "not assessed", not out-of-scope or non-compliant. It is an **informational tracking surface with sourced links, not legal advice** — see [Legal framing](#legal-framing--non-goals).

The data foundation already exists in the tracked registry: many coins carry a `jurisdiction` block, EU regulators and `"EMI (MiCA)"` licenses appear as free text, and EUR-pegged plus major USD coins are in scope. This feature **structures and classifies** that existing free text — it is not a green-field data collection effort. Derive current inventory counts from the registry rather than freezing them in this doc.

---

## Architectural keystone

MiCA is static editorial metadata in the compliance sidecar, not a Worker pipeline. [Compliance data projection](./compliance-page.md#data-projection) owns catalog loading and consumer boundaries. Missing metadata means unassessed, never an inferred legal posture.

---

## Schema

Author a dedicated `mica?: MicaProfile`, separate from generic `jurisdiction` and sibling `genius`. The regime-specific research criteria below decide what may be asserted; schema validity alone does not establish authorization.

### Types — `shared/types/core.ts`

`shared/types/core.ts` owns MiCA enum values and exports the Zod-derived `MicaProfile` type from `shared/types/stablecoin-meta-compliance-schemas.ts`. Read those sources for the current field shape rather than copying a type declaration.

### Zod — `shared/types/stablecoin-meta-compliance-schemas.ts`

`MicaProfileSchema` in `shared/types/stablecoin-meta-compliance-schemas.ts` owns strict shape and cross-field validation, including evidence references and the out-of-scope field boundary. Apply the [status criteria](#status-criteria) before authoring.

### Wiring — `shared/lib/stablecoins/schema.ts`

`shared/lib/stablecoins/schema.ts` assembles the profile into `StablecoinMetaAssetSchema`. Validate metadata edits through the [maintenance checks](#maintenance).

---

## Status criteria

Editorial assignment rules. Each non-`out-of-scope` status should carry at least one `references` link to the source that justifies it.

| Status | Assign when | Source of truth |
| --- | --- | --- |
| `authorized` | Issuer holds an in-effect EMI or credit-institution authorization for this token, listed on a competent-authority / ESMA register. **Requires a `references` link.** | ESMA register; EBA EMT/ART issuer registers; national registers (e.g. ACPR REGAFI, BaFin, DNB) |
| `pending` | Application filed with a competent authority; decision outstanding. | Issuer disclosure + authority filing |
| `transitional` | Offered/traded on EU venues under a member-state CASP grandfathering window (no issuer authorization yet). Every EU CASP window ended by 1 Jul 2026 (MiCA Art. 143(3)), so no current row should carry this status. | National transitional-regime notices |
| `non-compliant` | In EU scope but no authorization and no transitional cover; delisted or restricted on EU venues. Requires an in-force EU-venue notice or EU regulator source naming this exact token; register absence alone never suffices. When any part is doubtful, leave the row unassessed. | Exchange delisting notices, issuer statements |
| `out-of-scope` | Not offered to the public or admitted to trading in the EU, or reviewed legal/source evidence indicates the token is outside EMT/ART issuer authorization requirements (for example, no identifiable issuer for Titles II-IV). | Reviewed EU-offering or issuer-scope evidence; not a default for missing research |

Leave `mica` **undefined** for coins not yet assessed — the page distinguishes "not assessed" (no row / muted) from `out-of-scope` (explicitly reviewed). This bounds the backfill: only researched coins assert a status. Assert any status only at high confidence; an unresolved or contradictory evidence record stays unassessed rather than receiving a guessed status.

`out-of-scope` rows are explicit assessments, but they must not carry in-scope MiCA classification fields such as `tokenType`, `authorizationType`, `competentAuthority`, or `authorizedEntity`. Use those fields only when the row is asserting an EMT/ART posture inside the MiCA status model.

### Token type (`tokenType`)

- **EMT (E-money token):** references a single official currency. Most EUR and USD fiat-backed stablecoins are EMTs.
- **ART (Asset-referenced token):** references a basket or other value (multi-currency, commodity, or mixed). Rare in the tracked set.

### MiCA timeline anchors (for copy / the optional timeline strip)

- **30 Jun 2024** — Titles III (ARTs) & IV (EMTs) apply. EMT issuers have no issuance grandfathering. A narrow old-ART continuation exists in Art. 143(4)-(5): a lawful pre-30 Jun 2024 ART issuer that applied (or, for credit institutions, notified) before 30 Jul 2024 may continue until its application is decided; map a verified case to `pending`.
- **30 Dec 2024** — Title V (crypto-asset service providers) applies.
- **1 Jul 2026** — end of the longest national CASP transitional ("grandfathering") windows (Art. 143(3) ceiling; ESMA confirmed expiry on 23 Jun 2026); the "full application" milestone. Note this window covers **service providers/venues**, not issuers — status copy must not imply issuers are grandfathered.

Per-coin `significant` follows EBA designation of significant EMTs/ARTs (threshold-based; EBA-supervised).

---

## Page contract — `/compliance/`

[Compliance page composition](./compliance-page.md#page-composition) owns the route, tables, navigation and loading; [URL contract](./compliance-page.md#url-contract) owns filters; [data projection](./compliance-page.md#data-projection) owns lifecycle inclusion and evidence loading. MiCA status labels/descriptions/badge classes come from `shared/lib/mica.ts`, not route-local copies.

**Detail-page surfacing:** the hero passport strip (`src/lib/stablecoin-detail-passport.ts`) carries the MiCA/Historical MiCA field. `RegulatoryStandingCard` is a rail card at `xl+` with an in-flow twin in the Control board's tile grid below `xl` (`density="main"`, an evidence-module tile), and that twin owns `#jurisdiction`. The card lists one row per applicable regime (GENIUS / US, MiCA / EU), and each regime row holds status only: a sentence-case status pill (out-of-scope is muted) with the issuer pathway or token-type caption beside it. What the issuer publishes sits in a separate "Issuer disclosures" row (attestation, redemption policy, reserves), shown only with a GENIUS review and never as cells of a regime, because a published attestation says nothing about authorization. Redemption policy and reserves come from the GENIUS review; the attestation cell reads the coin's `proofOfReserves` record first, the same fact as the passport's Attestor entry, and falls back to the GENIUS review's monthly-attestation finding only without a record or with an undisclosed attestor. A recorded cadence is the value: a check for daily to monthly, a watch-tone gap for "Quarterly", "Semi-annual", "Annual" or "Ad hoc" (GENIUS requires monthly); "Self-attested" is a gap, and an attestor without a cadence reads "Not monthly" when the review found no monthly attestation. Published is a check (the reserve disclosure links to the disclosure), a reviewed absence reads "Not found", and a missing record a muted "Not recorded" with "–", never a cross. The value word always follows the glyph, so the card carries no legend. Regulator facts, report dates, review notes and sources fold under `Details & sources (N)` in the rail and `Review notes & sources (N)` in the twin. A coin without a curated regime profile gets no passport field and an explicit "Regulatory standing · Not reviewed" state in the same slots; nothing is faked on-page. The GENIUS passport chip still links off-page to `/compliance/?regime=genius` rather than `#jurisdiction`.

**Static export / SEO:** route is statically pre-rendered and included in the sitemap; run `npm run seo:check` after crawlability changes. No `next.config.ts` change.

Verify: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run seo:check`, plus a page render smoke test.

---


## Data sourcing & maintenance

This is the dominant cost, not the code.

- **Primary-source order:** ESMA authorized-entity register > EBA EMT/ART issuer and significant-token registers > national competent-authority registers (ACPR REGAFI, BaFin, DNB/AFM, MFSA, CBI, Bank of Lithuania) > issuer whitepapers or authorization disclosures > EU venue restriction/delisting notices.
- **Mapping is manual:** token → issuer entity → authorization is not cleanly API-able. Confirm the registered entity issues this exact token, not an affiliate; treat like the existing `reserve-research` / `resilience-classify` editorial workflows. Apply the [status criteria](#status-criteria), including register evidence for authorization and high-confidence, token-specific evidence for every assessment.
- **Backfill scope:** Prioritize EUR coins, major EU-traded USD coins, existing structured `mica` metadata, and records whose licenses mention MiCA. Assets without structured metadata remain unassessed, not implicitly out of scope; use the live compliance surface or source metadata for current status totals.
- **Maintenance:** statuses change as authorizations are granted/refused and venues delist. Periodic refresh against the registers runs through the `compliance-research` skill (`mica` regime).

### Worked reference examples (verify before entry)

Use current source metadata and the compliance surface for examples; confirm each token/entity/authorization against the source order above at data-entry time. A likely-status seed is not evidence.

---

## Maintenance

MiCA labels, descriptions, and badge classes live in `shared/lib/mica.ts`; status values remain in `shared/types/core.ts`. Ongoing work is data refresh through the `compliance-research` skill (`mica` regime) plus normal route/build checks.

- Data refresh: update or create the compliance sidecar's `mica` block with sourced register references, then run `npm run bootstrap:generated`, `npm run check:stablecoin-data`, and `npm run check:generated-artifacts`.
- Route verification: run `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run seo:check` when route/UI behavior changes.
- **Not a methodology-version bump:** MiCA status is a tracked attribute, not a score. Assignment criteria live in this doc, not in `/methodology` versioning.

---

## Legal framing & non-goals

- The tracker is **informational and sourced**, explicitly **not legal advice**; surface this on the page. Require a `references` link before asserting `authorized`.
- Be precise that the 1 Jul 2026 grandfathering window covered **CASPs/venues** and has ended, while EMT/ART **issuer** rules have applied since June 2024; the only issuer continuation is the decision-ended old-ART case in Art. 143(4)-(5) — copy must not overclaim.
- **Non-goals:** no automated regulatory scraping; no per-coin compliance scoring; no extra regulatory regimes beyond the dedicated MiCA and GENIUS profile models already surfaced on `/compliance/`.
