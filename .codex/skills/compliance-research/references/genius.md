# GENIUS Source Rules

`docs/genius-tracker.md` owns the schema, enum values, cross-field validation, and legal framing. `shared/lib/compliance-regime-state.ts` owns the current rulemaking/effective-date posture.

Use sources in descending authority: Federal Register; OCC, Federal Reserve, FDIC, NCUA, FinCEN, OFAC, or Treasury material; state regulators; issuer filings/disclosures; auditor reports; reputable news. News cannot establish an official status by itself. The complete `sourceKind` enum remains in `shared/types/core.ts`.

Official approval, qualification, application-pending, enforcement, and registered-exception claims must meet the regulator-grade source rules in the tracker. Confirm the source names this token’s issuer, not merely an affiliate or general license.

Assign applicability first. DeFi CDPs, yield wrappers, vaults, governance units, commodity tokens, and tokenized funds are usually outside the payment-stablecoin scope; record that explicitly with a sourced `applicabilityBasis` and `not-applicable` status (or `unclear` when the ambiguity is well documented). Ship a row only at high confidence: when the legal issuer, redemption obligation, or scope stays unresolved, leave the row absent rather than guess. A `no-public-authorization-found` conclusion requires the tracker’s dated negative-evidence review and sources checked.
