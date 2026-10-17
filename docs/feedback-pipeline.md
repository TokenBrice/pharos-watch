# Feedback Pipeline

In-app feedback routes to public GitHub Issues, not a private support inbox. `worker/src/api/feedback/` separates request/env policy, verification and GitHub submission/formatting. The request schema and API reference own validation/HTTP details, not copied prop/SQL/title tables here.

## Frontend Components

`FeedbackButton`, `MobileUtilityDock` and `FeedbackModal` are global/contextual entrypoints. Global triggers are absent on `/` and feedback is hidden on `/api/` so key requests cannot enter public Issues. Stablecoin hero and Show Your Work contextual triggers attach a canonical stablecoin for data-correction verification; global feedback does not.

The accessible dialog collects bug, data-correction or feature-request context and displays server errors inline. Optional contact handles are published in the resulting issue; disclose this before submission. A successful write shows thank-you state. Honeypot input is unfocusable/hidden from accessibility; nonempty traps are silently accepted but discarded.

Submit a collision-resistant Idempotency-Key. Retry the same serialized payload with the same key; changed payload gets a new key. HTTP 500 clears it (explicit GitHub rejection or pre-execution reservation failure); network failures and ambiguous 503 retain it. Production/preview uses the public API lane; local/explicit base settings follow `src/lib/api.ts`, not route-specific URL guesses.

## API Endpoint

[POST /api/feedback](./api-reference.md#post-apifeedback) owns authoritative request, validation, headers and error semantics. Valid requests require an idempotency key. Conflicting/in-flight reuse can return 409. Unknown GitHub execution returns 503 with `X-Execution-Certainty: unknown`; replaying the same key replays uncertainty without invoking GitHub again. Reconcile that outcome before submitting a new key: never turn timeout ambiguity into duplicate issues.

### Rate limiting And Privacy

[Worker/API limits](./worker-and-api-limits.md) generated feedback block and `shared/lib/ops-limits.ts` own numeric window/budget/retention. `worker/migrations/0000_baseline.sql` owns D1 schema; do not mirror SQL here.

Use trusted `CF-Connecting-IP`, falling back to unknown, never client-controlled X-Forwarded-For. Store only the salted truncated SHA-256 bucket, not raw IP. Admission is atomic; exhausted budget returns 429 and old buckets prune nonblocking. Current submissions write directly to GitHub, not a durable per-submission D1 store. Any future persistence needs an explicit privacy/retention contract first.

### Auto-verification

Only a data correction with valid attached stablecoin can verify. Read normalized stablecoins cache, nullable USD supply, price, cached peg type/reference and producer age. `verification.ts` owns arithmetic and shared threshold/reference helpers; DefiLlama list supply is already USD. Missing supply is explicitly unavailable, not zero; a finite observed zero remains measured. Commodity normalization uses reviewed metadata, and rate source is disclosed.

- `verified: confirmed`: a positive cached price is at/beyond the shared depeg threshold. This confirms observed deviation, not that the user's asserted correction is proven true.
- `verified: unconfirmed`: missing/nonpositive price, missing reference or deviation below threshold; never proof the report is wrong.
- `verified: pending`: verification did not run/complete, including no attached asset, missing cache row or unavailable cache.

Embed a dated-at-submission snapshot in the issue. Cached rates may include fallbacks; threshold/rate-source lookup may use tracked peg currency only when cached peg normalization fails. Snapshot age/evidence must not be presented as a live independent check.

### GitHub Triage

Bug/feature issues receive their type labels; data corrections also receive the verification label. `format.ts` owns canonical title/body assembly and caps. Normalize newlines, trim CRLF/NUL, defang mentions and escape long backtick runs before fencing user text; user input must not create unsolicited mentions or break issue structure. Preserve asset/page/value/expected-source/contact context where supplied, with public-contact disclosure.

## Environment Variables

`GITHUB_PAT` and `FEEDBACK_IP_SALT` are required secrets; absence of either returns 503, never unsalted storage or fake success. The GitHub token also supports Safety Score map dispatch: [provisioning](./safety-score-map.md#provisioning) owns permissions. Worker config owns nonsecret settings; no secret values belong in docs or logs.
