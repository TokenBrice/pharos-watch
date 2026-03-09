---
title: "Expand lending protocol allowlist"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Add vetted lending protocols to `LENDING_PROTOCOL_ALLOWLIST` to expand auto-discovery coverage.

## Task

1. **Read `worker/src/cron/yield-config.ts`** — Find `LENDING_PROTOCOL_ALLOWLIST` (line ~313-334). It's a Set of DeFiLlama project slug strings, organized by tier comments.

2. **Add new protocols** based on the orchestrator's research output. The orchestrator will amend this ticket with exact slugs and tier assignments.

   **AMENDMENT PLACEHOLDER — The orchestrator will replace this section with specific protocols:**
   ```
   // Example format:
   // Tier 2 additions: "moonwell-apollo", "silo-v2"
   // Tier 3 additions: "benqi-lending", "radiant-v2", "exactly"
   ```

3. **Placement:** Add Tier 2 entries after the existing Tier 2 comment block. Add Tier 3 entries after the existing Tier 3 comment block. Maintain alphabetical order within each tier if the existing entries follow that pattern.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `npm run build` exits 0
- `LENDING_PROTOCOL_ALLOWLIST` contains more entries than before
