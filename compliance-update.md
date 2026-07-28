# Compliance Update Recommendations

Audit date: 2026-06-18

## Scope

This audit reviewed the `/compliance` dataset and page using public official sources where available, issuer/auditor sources where necessary, and the local page/model implementation.

Dataset inventory at audit time:

| Regime | Rows |
|---|---:|
| Any compliance metadata | 130 |
| MiCA metadata | 40 |
| GENIUS metadata | 106 |
| Both MiCA and GENIUS | 16 |

Current status distribution:

| Regime | Status | Count |
|---|---|---:|
| MiCA | authorized | 16 |
| MiCA | non-compliant | 18 |
| MiCA | pending | 2 |
| MiCA | out-of-scope | 4 |
| GENIUS | no-public-authorization-found | 67 |
| GENIUS | issuer-announced-intent | 22 |
| GENIUS | not-applicable | 17 |

Validation performed:

- `npm run check:stablecoin-data` passed.
- All 130 rows with MiCA or GENIUS metadata were enumerated from `shared/data/stablecoins/coins/*.json`.
- The generated client registry was checked against authored source fields.
- 667 compliance-related references were checked for reachability; 390 unique URLs were encountered.
- Official MiCA register data was checked against ESMA's Interim MiCA Register page, whose current public page showed a latest update of 2026-06-12.
- GENIUS baseline was checked against current OCC, Treasury, FDIC, NCUA, FinCEN, and OFAC public rulemaking and licensing sources.

Official source baseline used:

- ESMA MiCA register page: https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica
- ESMA databases and registers page: https://www.esma.europa.eu/publications-and-data/databases-and-registers
- EBA MiCA supervision page: https://www.eba.europa.eu/activities/direct-supervision-and-oversight/ebas-supervisory-role-under-mica
- OCC GENIUS Act proposed rule, Bulletin 2026-3: https://www.occ.gov/news-issuances/bulletins/2026/bulletin-2026-3.html
- OCC GENIUS reporting proposal, Bulletin 2026-24: https://www.occ.gov/news-issuances/bulletins/2026/bulletin-2026-24.html
- OCC digital asset licensing applications: https://www.occ.gov/topics/charters-and-licensing/digital-assets-licensing-applications/index-digital-assets-licensing-applications.html
- Treasury state-regime comparability NPRM: https://home.treasury.gov/news/press-releases/sb0428
- Treasury/FinCEN/OFAC AML/CFT NPRM: https://home.treasury.gov/news/press-releases/sb0435
- FDIC GENIUS Act NPRM: https://www.fdic.gov/news/financial-institution-letters/2026/notice-proposed-rulemaking-establish-genius-act
- NCUA PPSI application proposal: https://ncua.gov/newsroom/press-release/2026/ncua-proposes-rule-permitted-payment-stablecoin-issuer-applications
- NCUA PPSI standards proposal: https://ncua.gov/newsroom/press-release/2026/ncua-announces-proposed-rule-permitted-payment-stablecoin-issuer-standards

## Executive Summary

The MiCA authorized classifications are well supported by the current ESMA EMT register. All 16 locally authorized MiCA rows matched ESMA EMT register entries during the audit.

The largest issue is not MiCA status accuracy; it is GENIUS semantics and page projection. Several GENIUS rows encode a likely or announced pathway as if it were an achieved pathway. Because implementing regulations and state-certification mechanics remain proposed as of 2026-06-18, these should either move to a separate "intended pathway" field or be reset to `unknown` unless a public application, approval, or registration supports the pathway.

The `/compliance` page does not expose every authored GENIUS data point. The source schema and `StablecoinClientMeta` type include fields such as `primaryFederalRegulator`, `foreignExceptionStatus`, `enforcementStatus`, `daspOfferSaleStatus`, `reserveDisclosurePresent`, `monthlyAttestationPresent`, `latestReportDate`, `reviewer`, and `reviewedAt`. These are now all included in the `GENIUS_COMPLIANCE_PROFILE_FIELDS` projection, so the data is available client-side; surfacing remaining dimensions in the UI is the open work.

The GENIUS reserve-attestation dates need a normalization pass. Many rows have `monthlyAttestationPresent: true` without `latestReportDate`, and several existing dates are stale relative to current public reports.

## Highest Priority Fixes

1. Fix GENIUS client projection.

   FIXED. All of the fields below are now members of `GENIUS_COMPLIANCE_PROFILE_FIELDS` in `shared/types/stablecoin-client-meta.ts`, and `scripts/build-data/build-client-registry.mjs` projects every one via `readGeniusComplianceFields()` / `projectGeniusProfile()` into `coins.compliance.generated.json`:

   - `primaryFederalRegulator`
   - `foreignExceptionStatus`
   - `enforcementStatus`
   - `daspOfferSaleStatus`
   - `reserveDisclosurePresent`
   - `monthlyAttestationPresent`
   - `latestReportDate`
   - `reviewer`
   - `reviewedAt`
   - `negativeEvidenceReview`
   - `foreignExceptionEvidence`

2. Fix the default `/compliance?regime=all` table behavior.

   FIXED. `src/app/compliance/client.tsx` now passes `showReserveDisclosure={hasGeniusRows(rows)}`, which shows the reserve disclosure column whenever the filtered result contains any GENIUS row, including in the default all-regime view.

3. Aggregate nested source references for page display.

   FIXED. `collectGeniusReferences` in `src/app/compliance/model.ts` now aggregates and dedupes references from top-level `references`, `applicabilityBasis`, `foreignExceptionEvidence`, and `negativeEvidenceReview`, so rows such as `cusd-celo` and `wemix-dollar-wemix` display their nested-evidence sources.

4. Decide actual pathway vs intended pathway semantics.

   For GENIUS, use `issuerPathway` only for a public, currently supportable pathway. If product wants to show likely future routing, add a separate field such as `intendedIssuerPathway` or `announcedIssuerPathway`. Do not use `foreign-registered` or `state-qualified` as a stand-in for "could qualify later" while Treasury state-comparability and foreign-exception frameworks are still proposed.

5. Refresh all GENIUS negative-evidence reviews to the 2026-06-18 source baseline.

   Rows reviewed on 2026-06-07 predate OCC Bulletin 2026-24 and the latest public licensing tracker state used in this audit. Add the current OCC, Treasury, FDIC, NCUA, FinCEN, and OFAC baseline sources where relevant.

6. Normalize reserve disclosure source kinds.

   Several rows mark issuer dashboards or protocol dashboards as `auditor-report`. Use `auditor-report` only for auditor/accountant reports. Use `issuer-disclosure` or add a more specific source kind for dashboards.

7. Add source taxonomy for non-U.S. regulators and statutes.

   Current rows force HKMA, CBUAE, CNAD, and Congress.gov sources into imperfect source kinds. Add source kinds such as `foreign-regulator`, `statute`, and `regulator-directory`, or document the current mapping.

## Page and Model Findings

| Severity | Area | Finding | Recommendation |
|---|---|---|---|
| High | Client projection | Authored GENIUS fields are dropped from `coins.client.generated.json`, including fields the page model reads. | Expand `GENIUS_CLIENT_FIELDS`, regenerate client data, and add a regression check that every `StablecoinClientMeta["genius"]` page field survives projection. |
| High | Source display | Nested GENIUS evidence sources are not surfaced when top-level `references` is absent. | Aggregate references from `negativeEvidenceReview`, `applicabilityBasis`, `foreignExceptionEvidence`, and posture fields, or enforce top-level references. |
| Medium | All-regime view | Reserve disclosure is hidden unless the user selects `regime=genius`. | Show reserve information in default all-regime tables for GENIUS rows. |
| Medium | Display coverage | Page/docs imply more GENIUS dimensions than the UI shows. | Add a details drawer or expanded row for foreign-exception posture, enforcement posture, DASP posture, monthly attestation, reviewer, review date, notes, and negative-evidence summary. |
| Medium | Lifecycle display | Pre-launch and frozen assets with MiCA metadata are excluded from visible compliance tables. | Confirm this is intentional. If so, document it on the page; otherwise add a pre-launch/frozen section. |

## MiCA Findings

### Supported Authorized Rows

The following local `mica.status: "authorized"` rows matched the current ESMA EMT register during the audit:

| id | Recommended action |
|---|---|
| `chfau-allunity` | No status change. |
| `eurau-allunity` | No status change. |
| `eurc-circle` | No status change. |
| `eurcv-societe-generale-forge` | No status change. |
| `eure-monerium` | No status change. |
| `euri-banking-circle` | No status change. |
| `euroe-membrane` | No status change, but decide whether frozen authorized rows should display on `/compliance`. |
| `europ-schuman` | No status change. |
| `eurq-quantoz` | No status change. |
| `eurr-stablr` | No status change. |
| `gbpe-monerium` | No status change. |
| `usdc-circle` | No status change. |
| `usdcv-societe-generale-forge` | No status change. |
| `usdg-paxos` | No status change. |
| `usdq-quantoz` | No status change. |
| `usdr-stablr` | No status change. |

### MiCA Rows Needing Action

| id | Finding | Recommendation |
|---|---|---|
| `deuro-deuro` | Resolved: `mica.status` is now `"out-of-scope"`, matching references that argue MiCA Titles II-IV are not applicable due to no central issuer. `tokenType` remains unset, which is consistent with an out-of-scope asset. | No further action unless it is re-scoped as an in-scope euro-referenced EMT. |
| `eur-qivalis` | Pending status is plausible from issuer/BNP public statements, but no current ESMA listing and no official DNB filing source was found. | Keep pending only if public filing evidence is sufficient; otherwise reduce confidence or add official regulator evidence. Confirm lifecycle handling because the row is pre-launch and not visible in the main table. |
| `usdm-moneta` | Pending status has public issuer/regulator context, but no ESMA row. | Keep pending with a current official regulator source, or mark as lower-confidence pending until official register evidence appears. |
| `eurr-stablr` / `usdr-stablr` | Authorized status remains supported, but public incident references indicate an unbacked mint/freeze event. | Do not downgrade authorization unless MFSA/ESMA revokes it. Add an incident/compliance caveat that is visible on the detail view. |
| All MiCA rows | Several source labels say "updated 4 Jun 2026" or reference the ESMA CSV path date rather than the current ESMA page update. | Normalize source labels to the current checked date, 2026-06-12 for ESMA page update and 2026-06-18 for this audit. |

### MiCA Coverage Queue

These are not verified bugs, but they should be considered for explicit MiCA metadata if `/compliance` is meant to cover all potentially in-scope non-USD or tokenized-money products:

- `rusd-revolut`
- `rgbp-revolut`
- `tgbp-tokenised`
- `reur-royal-euro`
- `chfm-mento`
- `gbpm-mento`
- Spiko tokenized fund products such as `eursafo-spiko`, `eurspkcc-spiko`, `eutbl-spiko`, `gbpsafo-spiko`, and `uktbl-spiko`

## GENIUS Systemic Findings

### Pathway Semantics

The main GENIUS issue is semantic. A number of rows use `issuerPathway` for a plausible or announced future route. That can read as a present regulatory status. Until final implementing rules and certified state or foreign frameworks exist, prefer:

- `issuerPathway: "unknown"` for no-public-authorization rows unless there is a specific public application or announcement.
- `issuerPathway` only for the public route actually supported by evidence.
- A separate future-looking field if the product wants to show intended route.

### Foreign Exceptions

Do not use `foreignExceptionStatus: "not-applicable"` for foreign apparent payment stablecoins just because foreign-exception mechanics are not final. Use `unknown` or a stricter unqualified value unless a public registered-exception basis exists.

### Reserve Attestation Dates

Rows with `monthlyAttestationPresent: true` should carry `latestReportDate` when a dated public report exists.

Rows missing `latestReportDate` at audit time:

`aid-gaib`, `ausd-agora`, `eurc-circle`, `fdusd-first-digital`, `fidd-fidelity`, `mnee-mnee`, `pyusd-paypal`, `rlusd-ripple`, `tusd-trueusd`, `usat-tether`, `usd1-world-liberty-financial`, `usdg-paxos`, `usdgo-osl`, `usdh-native-markets`, `usdp-paxos`, `usdtb-ethena`, `xsgd-straitsx`, `xusd-straitsx`.

Also refresh rows with stale dates, including `audd-novatti`, `gusd-gemini`, `sbc-brale`, `usdc-circle`, and `usdglo-glo`.

## GENIUS Row-Level Recommendations

| id | Recommended update |
|---|---|
| `aed-rakbank` | Change `issuerPathway` from `foreign-registered` to `unknown`; refresh negative-evidence review to 2026-06-18. |
| `apxusd-apyx` | Downgrade reserve/transparency source from `auditor-report` unless a true third-party auditor/accountant report is added. |
| `audd-novatti` | Set `latestReportDate` to `2026-05-31` if accepting the current AUDC May report source. |
| `ausdt-tether-alloy` | Replace or verify Alloy GitBook URLs that fail TLS/static fetch checks. |
| `aznd-mu-digital` | Refresh old review and fill issuer domicile if a public issuer source supports it. |
| `bils-bitsofgold` | Change `issuerPathway` to `unknown`; add official Israeli regulator or issuer source if relying on foreign approval context. |
| `cusd-celo` | Change `issuerPathway` to `unknown`; change `foreignExceptionStatus` to `unknown`; remove foreign-exception evidence unless a registered exception is supported. Add top-level references or aggregate nested references for the page. |
| `ejpy-jbfd` | Change `issuerPathway` to `unknown`. |
| `emxn-telcoin` | Change `issuerPathway` from `state-qualified` to `unknown`, or move it to an intended-pathway field. |
| `eusd-telcoin` | Change `issuerPathway` from `state-qualified` to `unknown`, or move it to an intended-pathway field. |
| `eurc-circle` | Change `issuerPathway` from `foreign-registered` to `unknown` unless using an explicit intended-pathway field. Add current reserve report date. |
| `fdusd-first-digital` | Change `issuerPathway` to `unknown`. Add current reserve report date if available. |
| `fidd-fidelity` | Add `latestReportDate: "2026-04-30"` if accepting the current report source. |
| `fiusd-fiserv` | Participating bank issuers are not named in the current evidence. Set `issuerPathway` to `unknown` unless specific issuing-bank evidence is added. |
| `gusd-gemini` | Update stale `latestReportDate` from `2026-03-31` to `2026-04-30` if accepting the current Paxos/Gemini report source. |
| `hkd-hsbc` | Change `issuerPathway` to `unknown`; use a foreign-regulator source kind for HKMA evidence. |
| `hkdap-anchorpoint` | Change `issuerPathway` to `unknown`; use a foreign-regulator source kind for HKMA evidence. |
| `honey-berachain` | Reassess `applicability`; `apparent-payment-stablecoin` is too strong for the current evidence. Use `unclear` or `non-payment-token` unless payment-token evidence is added. |
| `jupusd-jupiter` | Qualify Anchorage/USDtb "GENIUS-compliant" support as reserve-asset evidence, not direct JupUSD issuer authorization. |
| `m-m0` | Downgrade M0 dashboard source from `auditor-report` to `issuer-disclosure` unless independent auditor evidence is added. |
| `mtbill-midas` | Congress.gov source is not a federal-register source. Add `statute` source kind or remap the source. |
| `musd-metamask` | Replace Bridge blog reference labeled as OCC/federal regulator with official OCC CD1365 PDF. Downgrade M0 dashboard source unless auditor evidence is added. |
| `mxne-real-mxn` | Brale blog source should be `issuer-disclosure`; refresh review date. |
| `pathusd-bridge` | Add official OCC CD1365 reference for Bridge charter context; refresh negative review to 2026-06-18. |
| `pyusd-paypal` | Add `latestReportDate: "2026-04-30"` if accepting Paxos' current PYUSD transparency source. |
| `rlusd-ripple` | Add `latestReportDate: "2026-04-30"` if accepting Ripple's current transparency source. Revisit pathway semantics if stored as state-qualified. |
| `sbc-brale` | Update stale `latestReportDate` to `2026-05-31` if accepting Brale's May report. |
| `tusd-trueusd` | Keep enforcement warning. Add a latest report date only if a stable dated daily/monthly report URL can be captured reliably. |
| `usat-tether` | Add `latestReportDate: "2026-04-30"` if accepting Anchorage reserve attestation source. |
| `usd1-world-liberty-financial` | Add `latestReportDate: "2026-04-30"` if accepting BitGo attestation source. |
| `usdc-circle` | Update stale `latestReportDate` to `2026-04-30` if accepting Circle's current transparency source. Add official OCC charter reference if using Bridge-related pathway context elsewhere. |
| `usdf-flipcash` | `primaryFederalRegulator: "OCC"` and `stateRegulator: "NYDFS"` overstate GENIUS-specific posture when `issuerPathway` is unknown. Move regulator context to `licensingRegulator` unless pathway changes. |
| `usdg-paxos` | Add `latestReportDate: "2026-04-30"` if accepting Paxos' current USDG transparency source. |
| `usdglo-glo` | Update stale `latestReportDate` to `2026-05-31` if accepting Brale's May report. |
| `usdgo-osl` | Add `latestReportDate: "2026-04-30"` if accepting Anchorage reserve attestation source. |
| `usdh-native-markets` | Add `primaryFederalRegulator: "OCC"` and `latestReportDate: "2026-04-30"` if accepting current CD1365 and reserves evidence. |
| `usdp-paxos` | Add `latestReportDate: "2026-04-30"` if accepting Paxos' current USDP transparency source. |
| `usdsui-sui` | Add official OCC CD1365 reference, `primaryFederalRegulator: "OCC"`, and fuller `licensingRegulator` context. |
| `usdt-tether` | `enforcementStatus: "no-public-action-found"` is incorrect for Tether history. Change to at least `warning-or-notice`, add CFTC and NYAG regulator-grade references, and note that these are historical actions rather than a current GENIUS authorization status. Also revisit `issuerPathway: "foreign-registered"` unless represented as intended pathway. |
| `usdtb-ethena` | Add `latestReportDate: "2026-04-30"` if accepting Anchorage reserve attestation source. |
| `usyc-hashnote` | Strengthen applicability-basis references with issuer docs. Remove or downgrade unsupported SEC/CFTC claims unless official URLs are added. |
| `wemix-dollar-wemix` | Change `issuerPathway` to `unknown` and `foreignExceptionStatus` to `unknown`. Add top-level references or aggregate nested references for the page. |
| `xo-exodus` | Change `issuerPathway` from `state-qualified` to `unknown`; keep NYDFS context in `licensingRegulator` only. |
| `xsgd-straitsx` | Add `latestReportDate: "2026-04-30"` if accepting current StraitsX report source. |
| `xusd-straitsx` | Add `latestReportDate: "2026-04-30"` if accepting current StraitsX report source. |

Rows not listed above had no individualized row-level correction from this audit beyond the systemic projection, pathway-semantics, source-kind, source-refresh, and reserve-date recommendations.

## Source Link Hygiene

Reference reachability found mostly bot-blocked pages, plus one clear stale URL.

Clear fix:

| URL | Issue | Recommendation |
|---|---|---|
| `https://docs.m0.org/raw/protocol/extensions.md` | 404 | Replace the `usdsc-startale` reference with the current M0 docs URL or remove it. |

Blocked or fragile sources to replace with issuer/regulator/static alternatives where possible:

- Coinbase blog URLs for AUDD, USDF, and XSGD returned 403.
- BusinessWire release URLs for Telcoin, Fiserv, WLTC, and Circle returned fetch errors.
- Payments Dive and Banking Dive references returned 403.
- The Block JupUSD reference returned 403.
- Alloy GitBook docs produced TLS/static fetch failures.
- Honey Berachain reserves returned 429.
- SoFi crypto page returned 403.
- `https://rwa.anzen.finance/transparency` did not resolve via static fetch; browser-verify or add a static backup source.
- Congress.gov and WisdomTree references were blocked by static fetch; keep if browser-verified, but prefer regulator or issuer static pages where available.

## Suggested Implementation Order

1. Fix client projection and page display first. Otherwise new data fields will remain invisible.
2. Apply GENIUS pathway-semantics cleanup. This prevents overstatement of present authorization.
3. Refresh negative-evidence review dates and add the 2026-06-18 official baseline sources.
4. Normalize reserve report dates and source kinds.
5. Reassess the small MiCA edge set, especially `deuro-deuro`, `eur-qivalis`, and `usdm-moneta`.
6. Replace stale or blocked source URLs.
7. Run:

   ```bash
   npm run check:stablecoin-data
   npm run check:pr -- --base=origin/main
   ```

## Documentation Updates Needed After Data Changes

If the implementation changes any field semantics or display behavior, update:

- `docs/compliance-page.md`
- `docs/mica-tracker.md`
- `docs/genius-tracker.md`
- `/methodology` content if public methodology semantics change
- The relevant timeline/changelog doc if methodology wording or public compliance logic changes
