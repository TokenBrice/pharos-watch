---
title: "Fix JSON-LD XSS vulnerability in stablecoin page templates"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Escape stablecoin-sourced data in JSON-LD `<script>` blocks to prevent stored XSS via malicious stablecoin names or symbols.

## Context

JSON-LD structured data is rendered using `dangerouslySetInnerHTML` with unescaped stablecoin metadata. If a stablecoin name contains `</script><script>...`, it breaks out of the JSON-LD block and executes arbitrary JavaScript.

**Research findings addressed:**
- R7 Finding C1: JSON-LD scripts render unescaped stablecoin data (stored XSS vector)

## Task

### 1. Create a JSON-LD escaping utility

In `src/lib/json-ld.ts` (new file), create a helper that safely serializes JSON-LD data:

```typescript
/** Safely serialize data for embedding in a <script type="application/ld+json"> tag. */
export function safeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\//g, "\\u002f");
}
```

### 2. Fix `src/app/stablecoin/[id]/page.tsx`

Find the JSON-LD `<script>` block (around line 168-194) that uses `dangerouslySetInnerHTML={{ __html: JSON.stringify(...) }}`. Replace `JSON.stringify(...)` with `safeJsonLd(...)` imported from the new utility.

### 3. Fix `src/components/breadcrumb-json-ld.tsx`

Same pattern — replace raw `JSON.stringify` in `dangerouslySetInnerHTML` with `safeJsonLd`.

### 4. Fix `src/app/stablecoins/[peg]/page.tsx`

Same pattern — replace raw `JSON.stringify` in `dangerouslySetInnerHTML` with `safeJsonLd`.

## Files Modified

- `src/lib/json-ld.ts` (new)
- `src/app/stablecoin/[id]/page.tsx`
- `src/components/breadcrumb-json-ld.tsx`
- `src/app/stablecoins/[peg]/page.tsx`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -r 'safeJsonLd' src/` shows the utility is used in all 3 JSON-LD locations
- `grep -r 'JSON.stringify' src/app/stablecoin/ src/app/stablecoins/ src/components/breadcrumb-json-ld.tsx | grep -i 'innerhtml'` returns nothing (no raw JSON.stringify in dangerouslySetInnerHTML)
- The `safeJsonLd` function escapes `<`, `>`, and `/` characters
