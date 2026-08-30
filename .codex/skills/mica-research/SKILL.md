---
name: mica-research
description: Research and populate EU MiCA compliance data (the `mica` field) for a tracked stablecoin in the Pharos dashboard. Use when adding or auditing MiCA authorization status, token type, competent authority, or issuer authorization in its compliance sidecar.
---

# MiCA Research

Research a stablecoin's standing under the EU Markets in Crypto-Assets Regulation (MiCA, Regulation (EU) 2023/1114) and write a sourced `mica` object into its routed compliance source when the evidence supports it.

## Read First

- Read `docs/mica-tracker.md` — the **source of truth** for the `mica` schema, the status criteria table, EMT/ART rules, sourcing requirements, and legal framing. Defer to it for classification; this skill is the workflow only. `docs/compliance-page.md` covers the shared `/compliance/` page contract (the old `/mica/` route moved there).
- Read the coin's base entry plus `shared/data/stablecoins/domains/compliance/<id>.json` when present (or `shared/data/stablecoins/coins.generated.json` for a merged runtime view). Treat the runtime stablecoin re-export as import-only; `mica` edits must match `shared/lib/stablecoins/schema.ts`. **Routing:** compliance research always belongs in the compliance sidecar; create it when absent and keep `mica`/`genius` out of the base file (`docs/process/stablecoin-research-sidecars.md`).
- Treat existing `jurisdiction` free text (`regulator`, `license` e.g. `"EMI (MiCA)"`, `"ACPR"`) as a starting hypothesis, not truth — verify against a register.

## Schema

The `mica` object (exact field names): `status`, `tokenType`, `authorizationType`, `competentAuthority`, `authorizedEntity`, `significant` (boolean), `references` (`{ label, url }[]`). All but `status` are optional. Enum values for `status`/`tokenType`/`authorizationType` live in `shared/types/core.ts` (`MicaProfile`) — the source file wins; the criteria table in `docs/mica-tracker.md` maps them to evidence.

**HARD RULES (Zod-enforced — `check:stablecoin-data` fails otherwise):** every status except `out-of-scope` requires at least one `references` link; and `out-of-scope` rows must not carry `tokenType`, `authorizationType`, `competentAuthority`, or `authorizedEntity`.

## Workflow

1. Read current state: `jurisdiction`, `pegMechanism` / pegged currency, any existing `mica`, and whether the coin is plausibly in EU scope at all.

2. Research the registers with `WebSearch` / `WebFetch` (browser fallback on 403 — claude-in-chrome/Playwright in Claude Code, `agent-browser` in Codex), in order of weight:
- ESMA register of authorized entities
- EBA registers of EMT/ART issuers (and the EBA "significant" list for `significant`)
- national NCA registers: ACPR REGAFI, BaFin, DNB / AFM, MFSA, CBI, Bank of Lithuania
- issuer disclosures (whitepapers, authorization announcements)
- EU venue delisting / restriction notices (evidence for `non-compliant`)

3. Map token → legal issuer entity → authorization on a register. This is manual, not API-able; confirm the entity matches the issuer of *this* token, not a same-name affiliate.

4. Assign `status` per the criteria table in `docs/mica-tracker.md`. Set `tokenType`: **EMT** = single official currency (most EUR/USD fiat-backed coins); **ART** = basket/commodity/other value (rare). When uncertain between two statuses, pick the more conservative one and explain why.

5. Present the proposed `mica` object with sources, access date, and confidence. If research-only, stop here. Otherwise, after approval, edit or create the compliance sidecar, then regenerate and validate:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
npm run bootstrap:generated
npm run check:stablecoin-data
```

For full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`.

## Status (defer to the spec table)

- `authorized` — in-effect EMI or credit-institution authorization for this token, on a register. Requires a `references` link; set `authorizationType`.
- `pending` — application filed with an NCA, decision outstanding.
- `transitional` — traded on EU venues under a member-state CASP grandfathering window, no issuer authorization yet.
- `non-compliant` — in EU scope, no authorization and no transitional cover; delisted/restricted on EU venues.
- `out-of-scope` — not offered to the public or admitted to trading in the EU.

## Guardrails

- Never fabricate an authorization; no `authorized` without a register link naming the issuer entity.
- Leave `mica` undefined for unassessed or clearly non-EU coins — "not assessed" (no row) differs from `out-of-scope` (explicitly reviewed). Do not stamp `out-of-scope` on coins you have not reviewed.
- Grandfathering covers CASPs/venues, not issuers: EMT/ART issuer rules have applied since 30 Jun 2024 with no issuance grandfathering. Do not imply issuers are grandfathered.
- Set `tokenType` / `authorizationType` / `significant` only when a source supports them — omit rather than guess.
- This is an informational, sourced tracking surface, not legal advice.

## Batch Mode

When processing multiple coins, work one at a time and present findings for 3-5 coins per approval round, then apply and continue. For a broad MiCA + GENIUS pass across many coins, use the saved `compliance-research` workflow (research → adversarial verify → reconcile), as in `genius-research`.
