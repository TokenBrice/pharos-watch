# 2026-03-14 Documentation Health Report — Pass 5

Aggregated close-out for the March 14, 2026 documentation audit and remediation pass.

## Scope

- Audited: 51 files under `/docs/`
- Audited: root `README.md`
- Verified live documentation surface: `/methodology/` via `src/app/methodology/page.tsx`, `src/app/methodology/methodology-shared.tsx`, and `src/app/methodology/methodology-sections.tsx`
- Auxiliary project docs inventoried: `AGENTS.md`, `CLAUDE.md`

## Documentation Health Summary

- Critical issues resolved: 0
- Major issues resolved: 7
- Minor issues resolved: 11

### Major issues resolved

| Area | Verified issue | Remediation |
| ---- | -------------- | ----------- |
| `README.md` data-source inventory | The top-level provider table drifted from the live pricing / FX / redemption / liquidity pipeline and also linked DefiLlama Yields to a dead human-facing URL. | Expanded the table to match the live worker pipeline and replaced the dead `https://yields.llama.fi/` reader link with `https://defillama.com/yields`. |
| `docs/stablecoin-detail-page.md` | The route contract showed `PriceTransparencyCard` as a separate top-level section even though runtime code nests it under `OverviewSection`. | Corrected section order, anchor notes, and responsibility tables to match the live detail-page composition. |
| `docs/data-flow-map.md` | The end-to-end map omitted the separate FX writer, omitted secondary FX/Dex-liquidity sources, and understated the 5-minute Telegram lane. | Corrected source lists, worker stages, storage notes, and the Telegram schedule description. |
| `docs/design-tokens.md` | JS token-map docs referenced a non-existent `PSI_BAND_COLORS` export from `src/lib/chart-colors.ts`. | Replaced the export list with the actual runtime exports. |
| `docs/design-language.md` | The homepage interactive-card description no longer matched live usage. | Rewrote the pattern note so it reflects the current split between the about-page grid and homepage `pharos-card-shell` callouts. |
| `docs/documentation-map-2026-03-05.tsv` | The file was being described as a March 5 snapshot even though later audit rows had been added. | Marked it as a legacy-named, non-canonical audit-support artifact and updated the docs index wording accordingly. |
| `docs/pricing-pipeline.md` | Primary consensus docs omitted `curve-oracle`, and authoritative-override docs still claimed `crvusd-curve` used the override registry. | Added the `curve-oracle` consensus source and removed `crvusd-curve` from the authoritative-override scope. |

### Minor issues resolved

| Area | Verified issue | Remediation |
| ---- | -------------- | ----------- |
| `README.md` / `docs/architecture.md` | Migration count was stale at `73`, and some route/component descriptions had drifted. | Corrected the migration count to `74` and updated the affected role descriptions. |
| `docs/cemetery-and-compare.md` | Compare URL docs used an outdated constant name and understated the accepted token contract. | Updated the constant name and noted legacy DefiLlama / historical ID decoding. |
| `docs/about-page.md` | The route contract notes lagged the current ratings/reference and DEX source-group copy. | Added explicit notes for the live FX/reference and DEX-source groups. |
| `docs/classification.md` | The FX paragraph omitted Open Exchange Rates cross-validation, and the supplemental-asset selection rule was broader than the live implementation. | Updated both paragraphs to match `sync-fx-rates.ts` and the supplemental asset filters. |
| `docs/scripts.md` | The script inventory omitted `scripts/check-cron-schedule-sync.ts`. | Added the script and documented its current local-only role. |
| `docs/blacklist-tracker-timeline.md` | Timeline notes still described methodology metadata as future UI/API surfacing. | Updated the note to reflect current API/page usage. |
| `docs/bluechip-ratings.md` | Frontend consumer list omitted the `/coverage` model. | Added the `useCoverageMatrixModel()` consumer. |
| `docs/feedback-pipeline.md` | Sanitization wording overstated how aggressively the worker rewrites user strings. | Narrowed the claim to the fields the handler actually normalizes. |
| `docs/telegram-alerts.md` | Webhook auth docs only described query-string secret validation. | Documented the preferred header-based secret with legacy query fallback. |
| `agents/research/2026-03-14-documentation-audit-manifest.md` | The manifest did not explicitly inventory the live `/methodology/` surface and still framed the legacy docs map as historical. | Added the live route files and updated the docs-map note. |
| `shared/lib/redemption-backstop-version.ts` | The exported methodology anchor pointed to `/methodology/#safety-scores`, which no longer exists. | Updated the anchor to `/methodology/#safety-scores-methodology` so runtime links agree with the docs and page IDs. |

## Coverage Gaps Filled

- Added the live `/coverage` Bluechip consumer to the canonical Bluechip doc.
- Added the live `/methodology/` route surface to the audit manifest.
- Added the current ratings/reference and DEX-source copy notes to the about-page contract.
- Added `scripts/check-cron-schedule-sync.ts` to the scripts inventory.
- Clarified the legacy documentation-map artifact so contributors do not treat it as canonical history.

## Verification Evidence

- Internal markdown link check: passed
- Backticked repo path existence sweep: passed
- `git diff --check`: passed
- `npm run check:cron-sync`: passed (`10` triggers match)
- `npm run lint`: passed with 11 pre-existing `security/*` warnings in repo scripts and `worker/src/lib/twitter.ts`
- `cd worker && npx tsc --noEmit`: passed
- `npm test`: passed (`220` files, `1999` tests)
- `npm run build`: passed

## External Link Sweep

A stricter markdown-link HTTP sweep checked 28 human-facing external links referenced from `README.md` and `/docs/**`.

- Verified dead reader-facing link fixed in this pass: `https://yields.llama.fi/`
- Remaining non-200 responses were provider-side anti-bot / timeout / transient-origin behavior rather than clear documentation mistakes:
  - `https://api.curve.finance/` -> `520`
  - `https://defillama.com/protocols` -> `403`
  - `https://defillama.com/yields` -> `403`
  - `https://dexscreener.com/` -> `403`
  - `https://drpc.org/` -> `403`
  - `https://fred.stlouisfed.org/series/DGS3MO` -> timeout during automated fetch
  - `https://www.coingecko.com/en/api/onchain` -> `403`

## Worktree Note

Unrelated pre-existing local changes were left untouched in:

- `src/app/coverage/client.tsx`
- `worker/src/lib/cex-tickers.ts`
- `agents/research/2026-03-14-reserve-driven-classification-review.md`
