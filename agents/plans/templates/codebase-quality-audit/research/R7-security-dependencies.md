---
title: "Audit security posture and dependency health"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every security concern and dependency health issue — focused on input validation, injection risks, authentication, CORS, and dependency management.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report.

Pharos is a static Next.js export on Cloudflare Pages (no SSR). The API is a Cloudflare Worker. Authentication exists only for admin endpoints (status dashboard, backfill triggers). The user-facing dashboard has no authentication.

**Scope:**
- `worker/src/api/` — API handlers (input validation, auth, CORS)
- `worker/src/cron/` — external API calls (secret handling, error exposure)
- `worker/src/lib/` — middleware, auth, rate limiting
- `src/` — frontend (XSS, user input handling)
- `package.json`, `worker/package.json` — dependency manifests
- `worker/wrangler.toml` — worker configuration

## Task

### 1. Input Validation

- **Query parameter validation:** For each API endpoint that accepts query parameters, check if they're validated (type, range, allowed values) before use. Unvalidated params used in SQL queries are a SQL injection risk.
- **URL parameter validation:** Dynamic route parameters (e.g., stablecoin ID) — are they validated before being used in DB queries or external API calls?
- **Request body validation:** POST endpoints (feedback, telegram webhook) — is the body validated/sanitized before processing?
- **Path traversal:** Any endpoint that uses user input to construct file paths or URLs.
- **SQL injection:** Any place where user input is concatenated into SQL strings instead of using parameterized queries (`?` placeholders in D1 prepared statements).

### 2. Cross-Site Scripting (XSS)

- **`dangerouslySetInnerHTML`:** Every usage — is the input sanitized? What's the source of the HTML?
- **User-generated content:** The feedback form, any places where user text is displayed to other users (admin views). Is it sanitized?
- **URL-based content:** Data from URL parameters rendered in the page. Could a crafted URL inject content?
- **External data display:** Stablecoin names, descriptions, or other external data rendered without escaping. Could a malicious stablecoin name contain script tags?
- **Markdown rendering:** If any markdown is rendered client-side, is it sanitized?

### 3. Authentication & Authorization

- **Admin endpoint protection:** All admin endpoints in `worker/src/api/` — do they consistently check authentication? Are any admin actions accessible without auth?
- **Auth token handling:** How are admin tokens stored, transmitted, and validated? Are they in headers, cookies, or query params? Is the token comparison timing-safe?
- **Session management:** If sessions exist, how are they managed? Expiry? Rotation?
- **Rate limiting:** Are rate limiters applied to sensitive endpoints (feedback, auth, telegram webhook)?

### 4. CORS Configuration

- **CORS policy:** Review CORS headers in the worker. Is `Access-Control-Allow-Origin` appropriately restrictive? Is it `*` (too permissive) or properly scoped?
- **Preflight handling:** Are OPTIONS requests handled correctly?
- **Credentials policy:** If credentials are used, is `Access-Control-Allow-Credentials` set correctly?

### 5. Secret Management

- **Hardcoded secrets:** Grep for API keys, tokens, passwords hardcoded in source files (not in `.env` or Cloudflare secrets).
- **Secret exposure in logs:** Cron jobs or API handlers that log request/response bodies containing API keys or tokens.
- **Secret exposure in errors:** Error messages returned to clients that might leak internal configuration, API keys, or system details.
- **Environment variable usage:** Are all secrets accessed via `env` bindings (Cloudflare Worker secrets) rather than hardcoded?

### 6. External API Security

- **HTTPS enforcement:** Are all external API calls using HTTPS?
- **Certificate validation:** Any code that disables TLS verification?
- **API key exposure:** External API keys that might be exposed in client-side code (shipped in the static export).
- **Webhook validation:** Telegram webhook — is the incoming request validated (e.g., checking source IP or secret token)?

### 7. Dependency Health

Run these checks on both `package.json` and `worker/package.json`:

- **Known vulnerabilities:** Run `npm audit --json` in both root and `worker/` directories. List each vulnerability with severity and whether a fix is available.
- **Outdated dependencies:** Run `npm outdated` in both root and `worker/`. Flag major dependencies more than 2 major versions behind. Particularly: Next.js, React, TypeScript, Tailwind, TanStack Query.
- **Unused dependencies:** Packages listed in `dependencies`/`devDependencies` but never imported in source code. Check actual imports to verify.
- **Pinning strategy:** Are versions pinned (exact) or ranged (^, ~)? For production dependencies, exact pinning is more reproducible.
- **Lock file integrity:** Does `package-lock.json` exist and is it committed?

### 8. CI/CD Pipeline Security

- **Action version pinning:** Check `.github/workflows/` — are GitHub Actions pinned to SHA hashes or just major tags (`@v4`)? Major tag pinning is a supply-chain risk.
- **Secret scoping:** Are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and other CI secrets scoped appropriately (not available to PR builds from forks)?
- **Deployment permissions:** Does the workflow use appropriate permissions declarations?

### 9. Environment Variable Completeness

- **Env type vs documentation:** Compare the `Env` type definition in `worker/src/lib/env.ts` against `.env.example` and `worker/wrangler.toml` `[vars]`. Flag any secrets that might be in `[vars]` instead of Cloudflare secrets, and any env vars missing from documentation.
- **Dev/prod parity:** Are there environment variables used in code but not documented for local development setup?

### 10. Cloudflare Worker Specific

- **Binding security:** D1, KV, or other bindings — are they accessed securely?
- **Execution limits:** Any patterns that could exceed Worker CPU time limits (10ms/50ms on free/paid) or memory limits?
- **Information disclosure:** Error responses that reveal internal Worker details (stack traces, D1 errors, internal paths).

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R7: Security & Dependency Health Audit Report

## Summary
- Files audited: N
- Findings by severity: N critical, N important, N minor
- Findings by category: N input-validation, N XSS, N auth, N CORS, N secrets, N external-API, N dependencies, N CI/CD, N env-config, N worker

## Critical Findings (exploitable vulnerabilities or high-severity dep issues)

### Finding C1: [Short description]
- **Category:** [Input Validation | XSS | Auth | CORS | Secrets | External API | Dependencies | Worker | CI/CD | Env Config]
- **Files:** `path:line`
- **OWASP reference:** [if applicable — e.g., A03:2021 Injection]
- **Description:** [The vulnerability and how it could be exploited]
- **Impact:** [What an attacker could achieve]
- **Suggested fix:** [Concrete remediation]
- **Effort:** [Low | Medium | High]
- **Risk:** [Low | Medium | High]

## Important Findings (defense-in-depth gaps, not directly exploitable)
### Finding I1: ...

## Minor Findings (hardening opportunities)
### Finding M1: ...

## Input Validation Matrix
| Endpoint | Query Params | URL Params | Body | SQL Parameterized | Validated |
|----------|-------------|------------|------|-------------------|-----------|
| GET /api/stablecoins | [params] | N/A | N/A | [Yes | No] | [Yes | Partial | No] |
| POST /api/feedback | N/A | N/A | [fields] | [Yes | No] | [Yes | Partial | No] |
| ... | ... | ... | ... | ... | ... |

## Auth Coverage
| Endpoint | Requires Auth | Auth Check Present | Rate Limited |
|----------|--------------|-------------------|-------------|
| [endpoint] | [Yes | No] | [Yes | No] | [Yes | No] |

## Dependency Audit
### Known Vulnerabilities
| Package | Severity | CVE | Affects | Fix Available |
|---------|----------|-----|---------|---------------|
| [pkg] | [Critical | High | Medium | Low] | [CVE-...] | [what's affected] | [version] |

### Unused Dependencies
- [package]: listed in [dependencies | devDependencies] — never imported

### Outdated Dependencies
| Package | Current | Latest | Behind By |
|---------|---------|--------|-----------|
| [pkg] | [ver] | [ver] | [N major] |
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all API endpoints, cron jobs, frontend input handling, CI/CD workflow, and env configuration
- Every finding has exact `file:line` references
- Every finding has effort and risk levels
- Input validation matrix covers all API endpoints
- Auth coverage table covers all admin endpoints
- Dependency audit covers both `package.json` and `worker/package.json`
- CI workflow actions checked for version pinning
- Env type compared against `.env.example` and `worker/wrangler.toml`
- No code changes were made (read-only audit)
