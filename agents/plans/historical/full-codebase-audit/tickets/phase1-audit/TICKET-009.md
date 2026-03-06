---
title: "Audit security (light touch)"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Light-touch security audit of the codebase. Check for obvious vulnerabilities without doing a full pentest. Produce `FINDINGS-SECURITY.md` in the worktree root.

## Task

### Scope

Authentication, input validation, SQL queries, CORS, CSP headers, secrets handling, and dependency security across the entire codebase.

### What to check

1. **Authentication**: Read `worker/src/lib/auth.ts` and check:
   - How are admin endpoints authenticated? (API key, token, etc.)
   - Is the auth check applied consistently to ALL admin/backfill endpoints?
   - Grep for all `backfill` and `admin` routes in `worker/src/router.ts` — do they all go through auth?
   - Is the auth mechanism secure? (constant-time comparison, no timing attacks)
   - Are auth credentials stored securely (Cloudflare secrets, not hardcoded)?

2. **SQL injection**: Search all `.ts` files in `worker/` for SQL queries:
   - Grep for string interpolation in SQL: template literals containing `SELECT`, `INSERT`, `UPDATE`, `DELETE` with `${` interpolation
   - Every user-supplied value in SQL should use parameterized queries (`?` placeholders with `.bind()`)
   - Flag ANY instance of string concatenation/interpolation in SQL as Critical

3. **XSS in frontend**: Search `src/` for:
   - `dangerouslySetInnerHTML` usage — is the HTML sanitized?
   - Direct insertion of API data into DOM without escaping
   - URL construction from user input without validation

4. **Input validation at API boundaries**: For each API handler that accepts query/path params:
   - Are numeric params parsed with `parseInt`/`parseFloat` and validated?
   - Are string params length-limited?
   - Could malformed input cause crashes or unexpected behavior?
   - Are there params that accept arbitrary strings passed to SQL or file paths?

5. **CORS configuration**: Read CORS handling in `worker/src/router.ts`:
   - What origins are allowed?
   - Is `Access-Control-Allow-Credentials` set?
   - Could the CORS config be exploited for cross-origin data theft?

6. **Secrets and credentials**: Search the entire codebase for:
   - Hardcoded API keys, tokens, or passwords (grep for patterns like `sk-`, `Bearer`, `apiKey = "`)
   - `.env` files checked into git (check `.gitignore`)
   - Sensitive values in `wrangler.toml` that should be in secrets
   - Check `worker/src/lib/env.ts` — are secrets typed as optional (could fail at runtime if unset)?

7. **Rate limiting**: Check if public API endpoints have rate limiting:
   - Is there any rate limiting middleware?
   - Could an attacker spam expensive endpoints (backfill, digest generation)?
   - Is the feedback endpoint rate-limited? (check `worker/src/api/feedback.ts` and `docs/feedback-pipeline.md`)

8. **CSP and security headers**: Check if the worker or frontend sets:
   - `Content-Security-Policy`
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options`
   - `Strict-Transport-Security`
   - Check `public/_headers` file (Cloudflare Pages headers)

9. **Dependency vulnerabilities**: Check:
   - `package.json` and `package-lock.json` — are there known vulnerable packages?
   - Run `npm audit --json 2>/dev/null | head -50` if possible
   - Check for outdated critical dependencies (Next.js, React, Cloudflare SDK)

### Files to examine

- `worker/src/lib/auth.ts` (authentication)
- `worker/src/router.ts` (CORS, route guards)
- `worker/src/api/*.ts` (all handlers — input validation, SQL queries)
- `worker/src/cron/*.ts` (SQL queries, external API calls)
- `worker/src/lib/db.ts` (SQL patterns)
- `worker/src/lib/env.ts` (secrets/config)
- `worker/wrangler.toml` (bindings, secrets)
- `src/components/**/*.tsx` (XSS — dangerouslySetInnerHTML)
- `public/_headers` (security headers)
- `.gitignore` (secrets exclusion)
- `package.json`, `worker/package.json` (dependencies)

### Output format

Write `FINDINGS-SECURITY.md` in the worktree root:

```markdown
# FINDINGS: Security (Light Touch)

## Summary
- X files examined
- Y findings (A critical, B high, C medium, D low)

## Security Posture Overview
(brief paragraph: auth mechanism, CORS policy, rate limiting status, header coverage)

#### Critical
(findings or "None")

#### High
(findings)

#### Medium
(findings)

#### Low
(findings)

## Files Examined
(list)
```

Each finding:
```
- [SEC-NNN] **Title** — Description. File: `path:line`. Vulnerability type (e.g., SQL injection, XSS, auth bypass). Risk and fix. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-SECURITY.md` exists in the worktree root
- File contains the security posture overview
- File contains all four severity sections
- Every finding has a `[SEC-NNN]` ID, vulnerability type, and effort tag
- Summary counts match actual findings
- NO actual secrets or credentials appear in the findings file
