---
title: "Create src/lib/urls.ts URL builder for stablecoin detail pages"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "low"
done: false
---

## Goal

Create a single centralized URL builder for stablecoin detail page links, replacing scattered inline path construction.

## Task

1. **Create `src/lib/urls.ts`** with the following content:

   ```ts
   /**
    * Build the canonical URL path for a stablecoin detail page.
    * Encodes the ID to handle future ticker-issuer format safely.
    */
   export function buildStablecoinUrl(id: string): string {
     return `/stablecoin/${encodeURIComponent(id)}/`;
   }
   ```

2. That is the entire file. Keep it minimal -- no other exports, no imports needed.

3. Do NOT refactor any existing call sites yet. This function will be adopted incrementally in later phases.

## Acceptance Criteria

- `npm run build` exits 0
- File exists at `src/lib/urls.ts`
- File contains exactly one exported function `buildStablecoinUrl`
- `grep -c 'encodeURIComponent' src/lib/urls.ts` returns 1
