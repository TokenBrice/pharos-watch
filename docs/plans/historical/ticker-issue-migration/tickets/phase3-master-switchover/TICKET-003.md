---
title: "Re-key logos.json and ai-summaries.json with canonical IDs"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Update the keys in static data JSON files from legacy IDs to canonical ticker-issuer IDs.

## Task

### 0. Write a migration script

**Do NOT manually edit the JSON files.** Write a Node.js script at `scripts/rekey-static-json.js` that:
1. Reads the mapping table
2. Builds a combined `oldId → newId` lookup from all three sections
3. Re-keys both JSON files programmatically
4. Logs unmapped keys to stderr
5. Writes the results back

### 1. Build the mapping lookup

Use the mapping table at `./DESIGN-MAPPING-TABLE.ts` (copied to the worktree root by the orchestrator). Copy the mapping data into the script as plain JS objects (the TS file has `as const` syntax — strip it for the script). The mapping table has three sections:

- `ID_MAPPING` (148 tracked stablecoins) — numeric, `cg-*`, `gold-*`, `silver-*` oldIds
- `SHADOW_ID_MAPPING` (2 shadow) — `"3"` and `"iron-finance"`
- `DEAD_ID_MAPPING` (~78 dead) — mix of numeric oldIds (21 entries like `"42"`, `"63"`) and `dead-*` prefixed oldIds (57 entries like `"dead-usnbt-1"`, of which 26 have `llamaId` fields for DL ID lookup)

**CRITICAL: `logos.json` uses plain numeric DL IDs as keys for dead stablecoins — NOT `dead-*` prefixed IDs.** The 57 `dead-*` prefixed entries in `DEAD_ID_MAPPING` will NOT match any logo keys directly. For dead entries with a `dead-*` oldId, check if they also have a `llamaId` field — if so, add a mapping from `llamaId → newId` as well. This handles the case where the logo key is the DL numeric ID but the mapping table only has the `dead-*` prefixed oldId.

**Collision on oldId `"3"`:** This appears in BOTH `SHADOW_ID_MAPPING` (→ `"ust-terra"`) and `DEAD_ID_MAPPING` (→ `"ust-terra-classic"`). **Shadow takes precedence** — the shadow mapping is the correct one for the actively-tracked entry. Build the lookup with this priority: ID_MAPPING first, then SHADOW_ID_MAPPING, then DEAD_ID_MAPPING (do not overwrite earlier entries).

### 2. `data/logos.json`

- This file maps stablecoin IDs to logo filenames (~263 keys total)
- For every key, look up in the combined mapping and replace the key with `newId`
- Logo filename values stay unchanged
- Example: `"1": "1-usdt.svg"` → `"usdt-tether": "1-usdt.svg"`
- **Unmapped keys (~76 keys will lack mappings):** These are DL stablecoin IDs that were never added to our tracking system (74 numeric), plus `gold-vro` and `cg-uscc`. For these:
  - Log them to stderr: `console.error("Unmapped logo key: ${key}")`
  - **Keep them unchanged** in the output (do not delete or re-key without a mapping)
  - After running, report the count of unmapped keys

### 3. `data/ai-summaries.json`

- This file maps stablecoin IDs to editorial summary text
- Same re-keying approach using the combined mapping
- Most keys should have mappings. A few may not (e.g., `"355"`, `"gold-vro"`, `"cg-uscc"` — these may have been added after the mapping table was built). Log unmapped keys to stderr and keep unchanged.

### 4. Verification

- Verify the JSON remains valid after re-keying (no duplicate keys, proper syntax)
- Verify every tracked stablecoin's new canonical ID appears as a key in logos.json (cross-reference `ID_MAPPING`)

## Acceptance Criteria

- `npm run build` exits 0
- Both files parse as valid JSON: `node -e "JSON.parse(require('fs').readFileSync('data/logos.json'))"` exits 0
- `node -e "JSON.parse(require('fs').readFileSync('data/ai-summaries.json'))"` exits 0
- `grep '"usdt-tether":' data/logos.json` returns 1 match
- `grep '"usdc-circle":' data/logos.json` returns 1 match
- No tracked/shadow stablecoin IDs remain as keys (unmapped dead-coin numeric keys are expected):
  - `grep -cE '^\s*"cg-' data/logos.json` returns 0 or the count of unmapped `cg-*` keys only (e.g., `cg-uscc`)
  - `grep -cE '^\s*"(gold|silver)-' data/logos.json` returns 0 or the count of unmapped gold/silver keys only (e.g., `gold-vro`)
- `grep '"usdt-tether":' data/ai-summaries.json` returns 1 match
- The script runs idempotently: `node scripts/rekey-static-json.js` twice produces identical output
- The script's stderr output lists all unmapped keys (verify count is reported)
