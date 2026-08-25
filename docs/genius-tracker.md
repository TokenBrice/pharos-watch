# GENIUS Compliance Tracker

**Status: shipped as part of `/compliance/`.** U.S. GENIUS Act metadata is the `genius` metadata extension on each tracked stablecoin. It renders in the canonical [Compliance Tracker](./compliance-page.md) at `/compliance/`, which keeps the exhaustive registry, and per coin on stablecoin detail pages through the Regulatory Standing card (`src/lib/regulatory-standing.ts`) and the hero passport item. This doc is the **source of truth for the `genius` schema, the status criteria, sourcing requirements, and legal framing** — the companion to [mica-tracker.md](./mica-tracker.md). The `genius-research` skill encodes the workflow; this spec encodes the rules.

GENIUS = the **Guiding and Establishing National Innovation for U.S. Stablecoins Act** (Public Law, signed 18 Jul 2025), the U.S. federal payment-stablecoin regime. It is an **informational, source-backed tracking surface, not legal advice** — see [Legal framing](#legal-framing-non-goals).

---

## Architectural keystone

GENIUS status is **static editorial metadata, not pipeline data**. It is authored in `shared/data/stablecoins/domains/compliance/<id>.json`, merged by the catalog loader, and projected at build into the slim global client registry for authorization-status labels and into `shared/data/stablecoins/coins.compliance.generated.json` for the `/compliance/` table's long-form evidence.

**No Worker endpoint, no D1 migration, no cron job, no API hook, no `next.config.ts` change.** One field does leave the presentation surface: `genius.issuerEntity` seeds the Safety Score V9 issuer key (`worker/src/lib/safety-score-v9-extension.ts`, run by the `compute-safety-score-v9` cron), so edit it with that issuer join in mind; `authorizationStatus` and the rest stay presentation-only. Missing `genius` metadata means **"not assessed"** — not "out of scope" and not "non-compliant". This is deliberate: the page distinguishes an unassessed coin (no row) from an explicitly reviewed one.

GENIUS is modeled as a set of **separate public dimensions**, not one broad "compliant" label, because the statute creates distinct questions: is the asset even a payment stablecoin? who is the issuer and on what pathway? what is the federal/state regulator posture? is there a foreign-issuer exception? has there been enforcement? are reserve/redemption disclosures present?

---

## Schema

A dedicated `genius?: GeniusProfile` object on `StablecoinMeta`, sibling to `mica?: MicaProfile` and `jurisdiction?`. Enums live in `shared/types/core.ts`, which re-exports the `GeniusProfile` type; the shape itself is inferred from `GeniusProfileSchema` in `shared/types/stablecoin-meta-schemas.ts` (`.strict()`, with cross-field `superRefine` rules) and is wired through `shared/lib/stablecoins/schema.ts`. Presentation labels/badges live in `shared/lib/genius.ts`. Regime effective-date state lives in `shared/lib/compliance-regime-state.ts`.

### Fields (`GeniusProfile`)

Required: `applicability`, `authorizationStatus`, `issuerPathway`, `reviewer` (string), `reviewedAt` (`YYYY-MM-DD`). Everything else is optional. `.strict()` rejects unknown keys.

| Field | Type | Notes |
| --- | --- | --- |
| `applicability` | enum | Is this an in-scope payment stablecoin? See [Applicability](#applicability). |
| `applicabilityBasis` | `{ summary (≥12 chars), references? }` | Why the applicability call was made. |
| `authorizationStatus` | enum | The headline status. See [Authorization status](#authorization-status). |
| `issuerPathway` | enum | Which GENIUS issuer route. See [Issuer pathway](#issuer-pathway). |
| `issuerEntity` | string | Legal issuer entity. |
| `issuerDomicile` | string | Issuer's country/state. |
| `licensingRegulator` | string | Free-text licensing context. |
| `primaryFederalRegulator` | enum | `OCC` \| `Federal Reserve` \| `FDIC` \| `NCUA` \| `Unknown`. |
| `stateRegulator` | string | For state-qualified pathways. |
| `foreignExceptionStatus` | enum | See [Foreign exception](#foreign-exception-posture). |
| `foreignExceptionEvidence` | `{ summary (≥12), references? }` | Required when `registered-exception`. |
| `enforcementStatus` | enum | `no-public-action-found` \| `warning-or-notice` \| `prohibited-or-revoked` \| `unknown`. |
| `daspOfferSaleStatus` | enum | Digital-asset-service-provider offer/sale posture. See [DASP offer/sale](#dasp-offersale-posture). |
| `reserveDisclosurePresent` | boolean | If `true`, **requires** `reserveDisclosureUrl`. |
| `reserveDisclosureUrl` | URL | Public reserve disclosure / attestation hub. |
| `redemptionPolicyPresent` | boolean | Public 1:1 redemption policy exists. |
| `monthlyAttestationPresent` | boolean | Monthly reserve attestation exists. |
| `latestReportDate` | `YYYY-MM-DD` | Date of the latest reserve report. |
| `notes` | string | Reviewer notes / caveats. |
| `references` | `GeniusReference[]` | See [Sourcing](#sourcing-source-kinds). |
| `negativeEvidenceReview` | `{ sourcesChecked[], summary (≥12), reviewer, reviewedAt, references? }` | **Required** when `no-public-authorization-found`. |
| `reviewer` | string | Who performed the review (e.g. `"Pharos compliance research"`). |
| `reviewedAt` | `YYYY-MM-DD` | When. |

`GeniusReference`: `{ label, url, sourceKind, sourceDate?, accessedAt? }`.

### Zod cross-field rules (Zod-enforced — `check:stablecoin-data` fails otherwise)

1. `ppsi-approved` | `state-qualified` | `official-application-pending` → `references` must include at least one of kind `federal-register`, `federal-regulator`, or `state-regulator`.
2. `issuer-announced-intent` → `references` must include at least one of `issuer-disclosure`, `issuer-filing`, `federal-register`, `federal-regulator`, or `state-regulator`.
3. `no-public-authorization-found` → a `negativeEvidenceReview` object is **required**.
4. `reserveDisclosurePresent: true` → `reserveDisclosureUrl` is **required**.
5. `foreignExceptionStatus: "registered-exception"` → `foreignExceptionEvidence` with at least one `federal-register` / `federal-regulator` reference is **required**.
6. `enforcementStatus: "warning-or-notice" | "prohibited-or-revoked"` → `references` must include at least one regulator-grade (`federal-register` / `federal-regulator` / `state-regulator`) reference.

---

## Applicability

The threshold question: is the asset a GENIUS-scope **payment stablecoin** at all?

| Value | Assign when |
| --- | --- |
| `apparent-payment-stablecoin` | Marketed/used as a 1:1 fiat-redeemable payment stablecoin (the in-scope core). |
| `excluded-deposit` | A tokenized bank deposit / deposit token, not a payment stablecoin. |
| `excluded-security` | A tokenized fund share, money-market fund, or other security (SEC-registered or private placement). |
| `excluded-national-currency` | A CBDC or tokenized sovereign currency. |
| `non-payment-token` | A yield/savings wrapper, CDP/over-collateralized DeFi unit, governance or algorithmic unit not offered as a payment instrument. |
| `unclear` | Genuinely ambiguous after review. |

**Do not bulk-assess.** Leave `genius` undefined for the long tail of DeFi-native, savings-wrapper, and tokenized-fund assets. Use an explicit non-`apparent-payment-stablecoin` row **sparingly** — only for prominent tokens (e.g. a large tokenized Treasury fund or wrapper) that are likely to be **confused** with a payment stablecoin and where clarifying the exclusion has real value. Missing metadata already means "not assessed".

---

## Authorization status

The headline `authorizationStatus`. **When uncertain between two statuses, pick the more conservative one** (e.g. `issuer-announced-intent` over `official-application-pending`, `no-public-authorization-found` over `issuer-announced-intent`) and explain in `notes`.

| Status | Assign when | Source bar |
| --- | --- | --- |
| `ppsi-approved` | An official source identifies a domestic **permitted payment stablecoin issuer** approval for this token/issuer. | Regulator or Federal Register reference (rule 1). |
| `state-qualified` | An official source identifies a **state-qualified** payment stablecoin issuer pathway for this token/issuer. | Regulator/state-regulator or Federal Register reference (rule 1). |
| `official-application-pending` | A public **regulator** source shows an application/registration is filed and pending. | Regulator or Federal Register reference (rule 1). |
| `issuer-announced-intent` | Issuer/partner materials signal a GENIUS-era issuance path, but **no token-specific official approval** was found. | Issuer disclosure/filing or stronger (rule 2). |
| `no-public-authorization-found` | A **dated negative-evidence review** found no qualifying public approval, application, or registration. | `negativeEvidenceReview` required (rule 3). |
| `not-applicable` | The reviewed asset is outside the tracked GENIUS payment-stablecoin authorization posture (pairs with an excluded/`non-payment-token` applicability). | — |
| `unknown` | Public posture not resolved from available sources. | — |

**HARD RULE:** never assert `ppsi-approved`, `state-qualified`, or `official-application-pending` without a regulator-grade reference that names the issuer of *this* token (not a same-name affiliate). No fabricated approvals. While the regime is in rulemaking (see [Regime state](#regime-state-effective-date)), genuine `ppsi-approved`/`state-qualified` rows should be exceedingly rare — most honest answers are `issuer-announced-intent` or `no-public-authorization-found`.

---

## Issuer pathway

`issuerPathway` records which GENIUS issuer route applies:

| Value | Meaning |
| --- | --- |
| `idi-subsidiary` | Subsidiary of an insured depository institution. |
| `federal-qualified-nonbank` | Federally qualified non-bank payment stablecoin issuer. |
| `state-qualified` | State-qualified issuer under a comparable state regime. |
| `foreign-registered` | Foreign issuer operating under the foreign-issuer exception. |
| `unknown` | Pathway not resolved. |
| `not-applicable` | Asset is out of scope. |

`primaryFederalRegulator` and `stateRegulator` qualify the pathway when known.

During rulemaking, avoid using `issuerPathway` for a merely theoretical route.
Use `unknown` unless public evidence supports the issuer's current or announced
GENIUS route. If product copy needs to show a likely future route, add a
separate future-looking field rather than overloading `issuerPathway`.

---

## Foreign exception posture

For non-U.S. issuers, `foreignExceptionStatus` tracks the GENIUS foreign-issuer pathway: `registered-exception`, `comparability-determined`, `registration-pending`, `not-qualified`, `not-applicable`, `unknown`. A `registered-exception` claim requires `foreignExceptionEvidence` with a federal-grade reference (rule 5).

## Enforcement posture

`enforcementStatus`: `no-public-action-found` (the dated default), `warning-or-notice`, `prohibited-or-revoked`, or `unknown`. The two action states require a regulator-grade reference (rule 6).

## DASP offer/sale posture

`daspOfferSaleStatus` tracks digital-asset-service-provider offer/sale restrictions on the token: `not-yet-restricted`, `restricted`, `foreign-lawful-order-condition-active`, `not-applicable`, `unknown`. While the regime is pre-effective, `not-yet-restricted` is the common posture for in-scope U.S.-marketed tokens.

## Reserve & redemption disclosure

`reserveDisclosurePresent` / `reserveDisclosureUrl`, `redemptionPolicyPresent`, `monthlyAttestationPresent`, and `latestReportDate` capture the public disclosure footprint GENIUS will require. Record what is **publicly present today**; presence of `reserveDisclosurePresent: true` requires a URL (rule 4).

---

## Sourcing & source kinds

Map token → legal issuer entity → public posture. This mapping is manual and not cleanly API-able; treat it like the `reserve-research` / `mica-research` editorial workflows.

`GeniusReference.sourceKind`, in descending authority for U.S. authorization claims:

1. `federal-register` — Federal Register notices/rules.
2. `federal-regulator` — OCC / Federal Reserve / FDIC / NCUA / FinCEN / OFAC / Treasury releases and bulletins.
3. `state-regulator` — state banking/financial regulator sources.
4. `foreign-regulator` — non-U.S. regulator materials. These can support foreign licensing context but do **not** satisfy U.S. GENIUS approval/application rules.
5. `statute` — enacted statutory text such as Congress.gov Public Law materials.
6. `regulator-directory` — regulator-maintained public directories or registries that identify licensed entities without being a token-specific GENIUS approval.
7. `issuer-filing` — issuer filings/registrations.
8. `issuer-disclosure` — issuer whitepapers, GENIUS-pathway statements, transparency pages, and issuer-operated reserve dashboards.
9. `auditor-report` — third-party accountant/auditor reserve attestations or assurance reports, not issuer dashboards.
10. `news` — reputable reporting (weakest; never sufficient alone for an official status).

Only `federal-register`, `federal-regulator`, and `state-regulator` satisfy the schema's regulator-grade source requirement for official U.S. GENIUS approval/application statuses. `foreign-regulator`, `statute`, and `regulator-directory` are useful evidence, but they are not substitutes for a token-specific U.S. approval, pending application, or registered foreign-issuer exception.

Always include `sourceDate` / `accessedAt` where available so the review is dated.

### Negative-evidence review

`no-public-authorization-found` is an honest, dated **negative** conclusion, not an absence of work. Its `negativeEvidenceReview` must list the `sourcesChecked` (regulator bulletins, Federal Register, issuer pages), a `summary` of what was looked for and not found, and a `reviewer` + `reviewedAt`. Refresh the date when re-verified.

---

## Regime state & effective date

GENIUS effective-date and rulemaking-phase state is centralized in `shared/lib/compliance-regime-state.ts` (`GENIUS_REGIME_STATE`), **not** per coin. Update that object when primary-regulator final rules are issued or the statutory fallback effective date changes. `rulemakingPhase` ∈ `pre-rulemaking` | `proposed-rules` | `final-rules-issued` | `effective`.

The compliance page renders **Implementation Watch** (separate from the main authorization table) while `rulemakingPhase !== "effective"`, and for pre-launch coins even after the regime is live — those rows never graduate to the main authorization table. GENIUS rows are forward-looking until the regime is effective. `sourceReferences` lets the effective-date posture cite multiple regulator rulemaking sources (OCC, FDIC, NCUA, FinCEN/OFAC, Treasury), not just one. Keep `reviewedAt` current when re-verified.

---

## Maintenance

After `genius` metadata edits:

```bash
npm run bootstrap:generated
npm run check:stablecoin-data
npm run check:generated-artifacts
```

After route/crawlability edits: `npm run typecheck`, `npm run build`, `npm run seo:check`.

Ongoing refresh runs through the `genius-research` skill (single coin / audit) or the saved `compliance-research` workflow (broad MiCA + GENIUS pass). GENIUS status is a tracked attribute, **not** a methodology-scored value — assignment criteria live in this doc, not in `/methodology` versioning.

---

## Legal framing & non-goals

- The tracker is **informational and sourced**, explicitly **not legal advice**; the page surfaces this.
- Never fabricate an approval. Official statuses (`ppsi-approved`, `state-qualified`, `official-application-pending`) require regulator-grade references that name *this* token's issuer.
- "Not assessed" (no `genius` row) is the default; do not bulk-stamp the long tail. Explicit exclusions are reserved for prominent confusable tokens.
- **Non-goals:** no automated regulatory scraping; no per-coin compliance scoring; no implication that the regime is effective while it is in rulemaking.
