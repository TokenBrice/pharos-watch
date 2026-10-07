# MiCA Source Rules

`docs/mica-tracker.md` owns the schema, status criteria, EMT/ART rules, validation, and legal framing; `shared/types/core.ts` owns enum values.

Use primary sources in this order: ESMA authorized-entity register; EBA EMT/ART issuer and significant-token registers; national competent-authority registers; issuer whitepapers or authorization disclosures; EU venue restriction/delisting notices. Confirm the registered entity issues this exact token.

Do not mark `authorized` without an in-effect authorization and register link. CASP grandfathering ended 1 Jul 2026 and never covered EMT issuers; the only issuer continuation is the decision-ended old-ART case in Art. 143(4)-(5). Use `out-of-scope` only after an explicit review; an unassessed token has no `mica` row. Assert `non-compliant` only when an in-force EU-venue notice or EU regulator source names this exact token; register absence alone never suffices. Any status requires high confidence: when evidence is unresolved or contradictory, leave the token unassessed. Set token type, authorization type, competent authority, entity, and significance only when the cited evidence supports them.
