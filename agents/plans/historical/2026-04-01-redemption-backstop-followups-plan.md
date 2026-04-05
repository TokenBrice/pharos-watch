## Redemption backstop follow-ups plan

Date: 2026-04-01

Scope: execute the justified follow-ups from the degraded redemption-backstop investigation without weakening current truth-boundary rules.

### Decisions

1. Falcon: patch now
   - Root cause: `usdf-falcon` degraded because the Falcon reserve adapter treated `DUSK` as an unknown asset and emitted a degrading warning even though the live payload showed only about `$105k` / `0.01%` exposure.
   - Action: classify `DUSK` as a known altcoin in the Falcon adapter and lock that behavior with a unit test.

2. GHO: keep conservative, no runtime change
   - Current residual issuance outside tracked GSM modules is still material (`~63.6%` on the investigated run).
   - There is no justified local patch unless we can prove additional redeemable GSM-backed modules that should count toward direct immediate capacity.
   - Action: no code change in this pass.

3. Reservoir: keep conservative, no runtime change
   - The public `/api/reserves/raw` payload still exposes no trustworthy upstream timestamp field.
   - Response headers expose transport/cache timing only, not a source-data publication timestamp that should be promoted to scoring-grade freshness.
   - Action: no code change in this pass.

### Validation

- Run targeted adapter and redemption-backstop tests.
- Run repo lint.
- Run root type-check and worker type-check.
