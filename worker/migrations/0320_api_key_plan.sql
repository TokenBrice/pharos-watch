-- rollout-safety: backward-compatible

-- Explicit plan for operator-issued standard keys ('free_partner', 'commercial',
-- 'institutional'). NULL preserves legacy rate-based monthly quota defaults
-- while failing closed on paid-endpoint entitlements until an operator assigns
-- an explicit plan. Donor and self-serve keys remain plan NULL.
ALTER TABLE api_keys ADD COLUMN plan TEXT;
