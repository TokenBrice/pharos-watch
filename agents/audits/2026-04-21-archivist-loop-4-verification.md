# 2026-04-21 Archivist Documentation Verification — Loop 4

## Scope

Loop 4 started after loop 3 was pushed at `43d1f39a`. Two read-only `gpt-5.4` / `xhigh` agents performed the final requested stop-loop verification against the current source tree.

## Issues Corrected

- API reference now correctly states unknown paths return `404` before route method validation.
- Status docs now report the current active set as 186 active stablecoins.
- Public backing-taxonomy copy no longer advertises active algorithmic backing pages.
- Stability Index page now links to the actual methodology anchor.
- Homepage docs now distinguish mobile DOM/visual order from `lg+` visual order for the Start Here callout and KPI strip.
- Digest docs now describe archive preview behavior and the weekly teaser.
- Yield docs now match the current `/yield` route layout.

## Verification Commands

Passed:

- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run typecheck`
- `npm run lint`

## Loop Result

Loop 4 found more than 3 code-verifiable errors, but the user explicitly instructed to stop after this loop. No further verification loop will be started after this correction pass is committed and pushed.
