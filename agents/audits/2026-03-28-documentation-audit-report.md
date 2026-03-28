## Documentation Audit Report

### Summary
- **Total loops executed**: 2
- **Total issues found and corrected**: 18 (Critical: 0, High: 0, Medium: 11, Low: 7)
- **Documents modified**: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/README.md`, `docs/about-page.md`, `docs/api-reference.md`, `docs/architecture.md`, `docs/worker-infrastructure.md`
- **Documents created**: none in scope
- **Documents merged**: none
- **Documents deleted**: none

### Loop-by-Loop Breakdown

#### Loop 1
- **Issues found**: 18 (Critical: 0, High: 0, Medium: 11, Low: 7)
- **Details**:

| File | Claim | Severity | Issue | Fix Applied |
|------|-------|----------|-------|-------------|
| `README.md` | Redemption backstops cover `135` configured assets | Medium | Live registry now contains `144` assets | Updated the feature summary count to `144` |
| `README.md` | Detail pages expose the full reserve/redemption/liquidity/safety surface for each stablecoin | Medium | Pre-launch coins route to `PreLaunchDetail`; reserve and redemption cards are conditional | Reworded the feature summary to describe live-asset dossiers plus conditional surfaces |
| `README.md` | Yield benchmark row still used `FRED €STR mirror / SNB current-rates page` wording | Medium | Current benchmark stack uses ECB Data API plus delayed SIX SARON guest access | Updated the source table wording |
| `README.md` | Pages Functions tree only surfaced `ops-origin.ts` as a shared helper | Low | Current runtime also depends on `functions/lib/ops-env.ts` | Added `functions/lib/ops-env.ts` to the structure snippet |
| `AGENTS.md` | `worker/src/lib/` is only DB/helpers/constants | Low | The directory now also contains runtime/auth/cache logic | Broadened the repo-map description |
| `CLAUDE.md` | Repo-backed `auto-memory` behavior exists | Low | No repo-verifiable mechanism supports that instruction | Replaced it with a repo-verifiable “adjust your approach” instruction |
| `docs/README.md` | Docs index is a complete verified entry point | Medium | `docs/yield-intelligence-operations.md` was omitted from the index | Added the missing operations doc |
| `docs/about-page.md` | Ratings/reference source roster still included the FRED €STR mirror and SNB current-rates page | Medium | Live `/about` source groups now use ECB 3M compounded €STR plus delayed SIX SARON guest access | Updated the source-roster note |
| `docs/about-page.md` | CTA buttons use `h-11` outline buttons on mobile | Low | The shared class uses `min-h-11`, and the Telegram CTA is `variant="default"` | Reworded the interaction note to match implementation |
| `docs/about-page.md` | “contact actions” is the live CTA set label | Low | The page exposes GitHub, Telegram/X, and profile links, not a dedicated contact CTA | Tightened the wording to “profile links” |
| `docs/architecture.md` | `worker/src/router.ts` owns dynamic route patterns | Medium | Dynamic route definitions live in `worker/src/route-registry.ts` | Updated the route-definition model description |
| `docs/architecture.md` | Architecture endpoint inventory was complete without `POST /api/backfill-blacklist-current-balances` | Medium | The endpoint is live in the shared endpoint registry and route registry | Added the missing endpoint row and API file entry |
| `docs/architecture.md` | `src/lib/blacklist-helpers.ts` exists and owns shared blacklist helpers | Medium | That file no longer exists; the relevant frontend file is `src/lib/blacklist-api.ts` | Replaced the stale path/description |
| `docs/api-reference.md` | Admin endpoint reference was complete | Medium | `POST /api/backfill-blacklist-current-balances` was missing | Added the endpoint to the inventory and documented its contract |
| `docs/api-reference.md` | `GET /api/health` response description ended at `circuits` | Low | The live handler also returns `telegramSummary` | Added the field to the sample payload and response table |
| `docs/api-reference.md` | `/api/report-cards` example still used methodology version `6.1` | Low | Live Safety Score methodology version is `6.8` | Updated the example payload |
| `docs/worker-infrastructure.md` | `fetch-tbill-rate` still used SNB wording in the daily connection-budget note | Medium | Current CHF benchmark fetches use delayed SIX SARON data | Updated the connection-budget note |
| `docs/worker-infrastructure.md` | Idempotent admin action list was complete without `POST /api/backfill-blacklist-current-balances` | Medium | The live idempotency registry includes that route | Added the missing route to the list |

#### Loop 2 (Terminal)
- **Issues found**: 0 (Critical: 0, High: 0, Medium: 0, Low: 0)
- **Details**: Re-ran targeted stale-pattern checks plus `npm run check:doc-sync`, `npm run check:doc-counts`, `git diff --check`, and `npm run test:merge-gate`; no additional Medium-or-higher issues were found in the corrected scope.

### Structural Changes
No merges, deletions, or new in-scope documentation files were needed. The correction pass stayed limited to claim-level updates in existing docs.

### Out-of-Scope Observations
- The worktree already contained substantial non-documentation changes under `worker/`, `shared/`, and `src/app/methodology/`; those were left untouched.
- The live-host claims (`pharos.watch`, `api.pharos.watch`, `ops.pharos.watch`, `ops-api.pharos.watch`) are runtime/environment facts rather than purely repo-verifiable facts, so they were only preserved where they already aligned with checked-in config and route wiring.

### Residual Risks
- Some runtime claims in docs depend on external infrastructure state that cannot be fully proven statically from the repo alone, especially Cloudflare host deployment state and Access configuration outside git-managed code.
- The methodology and about pages were verified against the checked-in Next.js route code, not against a live browser session, so purely presentational regressions outside code-level structure were not part of this pass.
