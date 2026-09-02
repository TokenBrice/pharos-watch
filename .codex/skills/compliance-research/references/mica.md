# MiCA Source Rules

`docs/mica-tracker.md` owns the schema, status criteria, EMT/ART rules, validation, and legal framing; `shared/types/core.ts` owns enum values.

Use primary sources in this order: ESMA authorized-entity register; EBA EMT/ART issuer and significant-token registers; national competent-authority registers; issuer whitepapers or authorization disclosures; EU venue restriction/delisting notices. Confirm the registered entity issues this exact token.

Do not mark `authorized` without an in-effect authorization and register link. Grandfathering may cover CASPs or venues, not EMT/ART issuers. Use `out-of-scope` only after an explicit review; an unassessed token has no `mica` row. Set token type, authorization type, competent authority, entity, and significance only when the cited evidence supports them.
