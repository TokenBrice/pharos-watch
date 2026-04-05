## Admin D1 Metrics Plan

Scope: add live D1 storage and trailing-24h usage telemetry to the admin-only status surface, without changing any public endpoint or public UI.

Plan:

1. Extend the admin `/api/status` supplement contract with an optional `d1Usage` block and `sectionErrors.d1Usage`.
2. Hydrate a dedicated worker-only Cloudflare D1 status config for `/api/status` from optional env bindings.
3. Fetch the same D1 database info + trailing 24h analytics that `wrangler d1 info` uses, then expose the result in the admin Pipeline lane only.
4. Document the new admin-only status block and required worker bindings.
5. Verify with targeted tests plus lint/type-check.
