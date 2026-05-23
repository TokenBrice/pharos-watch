---
name: mica-research
description: Research and populate EU MiCA compliance data (the `mica` field) for a tracked stablecoin. Use when adding or auditing MiCA authorization status, token type, competent authority, or issuer authorization in `shared/data/stablecoins/coins/*.json`.
---

# MiCA Compliance Research

Research a stablecoin's standing under the EU Markets in Crypto-Assets Regulation (MiCA, Regulation (EU) 2023/1114) and write a sourced `mica` object into the coin's per-coin JSON entry.

**`docs/mica-tracker.md` is the source of truth** for the `mica` schema, the status criteria table, the EMT/ART rules, sourcing requirements, and legal framing. Read it before classifying — do not re-derive the criteria from memory. This skill encodes the workflow; the spec encodes the rules.

## Input
User provides a stablecoin name, symbol, or ID from `shared/data/stablecoins/coins/*.json`, or a batch of them.

## Process

### Step 1: Read Current State

Read the coin's entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json` for a canonical runtime view). Treat the runtime stablecoin re-export as import-only. Note:
- `jurisdiction` (`{ country, regulator?, license? }`) — free-text `regulator` / `license` strings (e.g. `"EMI (MiCA)"`, `"ACPR"`) are a **starting hypothesis, not truth**. Verify against a register before asserting anything.
- `pegMechanism` and the pegged currency (single official currency → likely EMT; basket/commodity/multi-currency → likely ART).
- Whether `mica` already exists (if so, verify and refresh rather than blindly replace).
- Whether the coin is plausibly in EU scope at all. A coin not offered to the public or admitted to trading in the EU is `out-of-scope`, or left undefined if unassessed.

### Step 2: The `mica` schema

The object you are producing (exact field names — see `docs/mica-tracker.md` for the full Zod contract):

- `status` — one of `authorized` | `pending` | `transitional` | `non-compliant` | `out-of-scope`
- `tokenType` — `EMT` | `ART` (optional)
- `authorizationType` — `emi` | `credit-institution` (optional)
- `competentAuthority` — supervising NCA, e.g. `"ACPR"` (optional)
- `authorizedEntity` — legal issuer entity named on the authorization (optional)
- `significant` — boolean; EBA-supervised "significant" EMT/ART (optional)
- `references` — `{ label, url }[]` register/disclosure links (optional)

**HARD RULE:** `status: "authorized"` requires at least one `references` link. This is Zod-enforced (`MicaProfileSchema.superRefine`) and will fail `check:stablecoin-data` otherwise. Every non-`out-of-scope` status should carry at least one reference justifying it.

### Step 3: Research the registers

Use `WebSearch` / `WebFetch` (fall back to agent-browser on 403). Authoritative sources, in order of weight:

1. **ESMA register** of authorized entities.
2. **EBA registers** of EMT and ART issuers (and the EBA list of "significant" tokens for `significant`).
3. **National competent-authority registers:** ACPR REGAFI (France), BaFin (Germany), DNB / AFM (Netherlands), MFSA (Malta), CBI (Ireland), Bank of Lithuania.
4. **Issuer disclosures** — whitepapers, authorization announcements, EMI/credit-institution license statements.
5. **EU venue delisting / restriction notices** — exchange notices and issuer statements (evidence for `non-compliant`).

Map: token → legal issuer entity → authorization on a register. This mapping is manual and not cleanly API-able; treat it like the `reserve-research` / `resilience-classify` editorial workflows. Confirm the entity on the register actually matches the issuer of *this* token, not a same-name affiliate.

### Step 4: Assign status

**Defer to the status criteria table in `docs/mica-tracker.md`** for which status applies. Summary of the decision shape:

- `authorized` — in-effect EMI or credit-institution authorization for this token, listed on a register. **Requires a `references` link.** Set `authorizationType` accordingly.
- `pending` — application filed with an NCA, decision outstanding.
- `transitional` — offered/traded on EU venues under a member-state CASP grandfathering window, no issuer authorization yet.
- `non-compliant` — in EU scope, no authorization and no transitional cover; delisted/restricted on EU venues.
- `out-of-scope` — not offered to the public or admitted to trading in the EU.

Set `tokenType`: **EMT** references a single official currency (most EUR/USD fiat-backed coins); **ART** references a basket, commodity, or other value (rare in the tracked set).

When uncertain between two statuses, pick the **more conservative** one (e.g. `non-compliant` over `transitional`, `pending` over `authorized`) and explain why in your notes.

### Step 5: Guardrails

- **Never fabricate an authorization.** No `authorized` without a register link that names the issuer entity.
- **Leave `mica` undefined** for coins not yet assessed or clearly non-EU — the page distinguishes "not assessed" (no row) from `out-of-scope` (explicitly reviewed). Do not stamp `out-of-scope` on coins you have not actually reviewed.
- **Grandfathering is for CASPs/venues, not issuers.** The ~mid-2026 transitional window covers crypto-asset service providers; EMT/ART *issuer* rules have applied since 30 Jun 2024 with no issuance grandfathering. Status copy and notes must not imply issuers are grandfathered.
- This is an **informational tracking surface with sourced links, not legal advice**. Do not present conclusions as legal determinations.

### Step 6: Present Findings

Format your findings as:

```
## MiCA: <Coin Name> (<SYMBOL>) — ID: <id>

**Existing jurisdiction:** <country / regulator / license, or none>
**Source(s):** <register URLs and disclosures used, with access date>
**Confidence:** High / Medium / Low

### Proposed `mica`:

\`\`\`json
"mica": {
  "status": "authorized",
  "tokenType": "EMT",
  "authorizationType": "emi",
  "competentAuthority": "ACPR",
  "authorizedEntity": "<legal entity>",
  "references": [
    { "label": "ACPR REGAFI", "url": "https://..." }
  ]
}
\`\`\`

### Notes:
- <Why this status; what the register says; any conservative call made>
- <Data gaps or caveats>
```

Wait for user approval before applying. If the request is **research-only**, stop here.

### Step 7: Apply & Verify

After approval, use the Edit tool to add the `mica` object to the coin's JSON in the matching `shared/data/stablecoins/coins/*.json` file. **Place `mica` immediately after `jurisdiction`.**

Then regenerate and validate:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
node scripts/build-data/build-client-registry.mjs
npm run check:stablecoin-data
```

Fix any schema failures before reporting done. For full stablecoin additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`; `npm run build` alone is not sufficient.

## Quality Standards

- Every asserted status traces to a source; `authorized` traces to a register link naming the issuer entity.
- `competentAuthority` is the NCA short name (e.g. `ACPR`, `BaFin`, `DNB`), matching how the register identifies it.
- `tokenType`, `authorizationType`, `significant` are only set when the source supports them — omit rather than guess.
- When no register match exists and the coin is clearly EU-marketed without authorization, `non-compliant` is the honest answer; do not soften it to `pending` without a filing.

## Batch Mode

When asked to process multiple coins, work through them one at a time. Present findings for 3-5 coins at once, get batch approval, then apply and continue with the next group. Mirror `reserve-research`'s batch cadence.
