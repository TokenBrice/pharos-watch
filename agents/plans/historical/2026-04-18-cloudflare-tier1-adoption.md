# Cloudflare Tier 1 Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt two low-risk Cloudflare platform improvements: (1) bump the Workers `compatibility_date` from 2025-01-01 to current, (2) add a zone-level WAF rate-limiting rule as an upstream flood filter.

**Architecture:** Two independent phases shipped separately, each with its own rollback. Phase ordering by risk: compat-date bump → WAF rule. Each phase lands on its own worktree and gets its own PR. Phase 1 smokes on a Worker preview URL before production promote; Phase 2 is dashboard config plus a docs-only PR. Phases do not depend on each other; if either is abandoned, the other stands alone.

**Tech Stack:** Cloudflare Workers, Cloudflare WAF (Rate Limiting Rules), Wrangler Versions + Preview URLs, vitest, TypeScript.

**Out of this plan (deferred):** Cloudflare AI Gateway adoption for Anthropic digest calls. Evaluated and deferred in the 2026-04-18 review: the observability gain is modest versus existing `cron_runs` + circuit-breaker + `usage.output_tokens` capture, and the integration introduces a new failure mode (gateway token rotation, independent availability) without unlocking the flagship features (caching is not applicable to digest; fallback-model routing is a separate, bigger change). Revisit when a second LLM caller appears or fallback-model routing becomes a concrete ask.

---

## Pre-Flight — Verify Account State

The plan references Cloudflare account-side state that must be confirmed before implementation starts. These are read-only checks against the real Cloudflare dashboard.

**Files:**
- None (dashboard checks + `wrangler whoami`).

- [ ] **Step 1: Confirm Cloudflare plan level for the `pharos.watch` zone**

Dashboard path: Cloudflare dashboard → `pharos.watch` zone → Overview → upper-right plan badge (Free, Pro, Business, Enterprise).

**Expected state:** the Free or Pro plan is most likely. Record the plan name — several WAF rule thresholds, counting periods, and available match fields in Phase 2 depend on it.

- [ ] **Step 2: Confirm Cloudflare Access is configured and active**

Dashboard path: Cloudflare Zero Trust dashboard → Access → Applications.

**Expected state:** two applications exist for `ops.pharos.watch` (UI) and `ops-api.pharos.watch` (API). Note the Access plan (Zero Trust Free is up to 50 users). This does not gate any Phase here but confirms the assumptions in `docs/operator-origin-access.md`.

- [ ] **Step 3: Confirm the three custom domains on the Worker**

```bash
cd worker && npx --no-install wrangler deployments status --json | jq '{ version: .id, routes: (.resources // .bindings // .) }'
```

If `deployments status` is not recognized on the installed wrangler version, fall back to `wrangler deployments list` and read the first deployment's routes. Either command is acceptable — the goal is to visually confirm `api.pharos.watch`, `site-api.pharos.watch`, `ops-api.pharos.watch` are attached (they are declared in `worker/wrangler.toml:15-19`).

- [ ] **Step 4: Confirm wrangler auth**

```bash
cd worker && npx --no-install wrangler whoami
```

**Expected output:** the account email + account id. Confirms wrangler can issue preview versions for Phase 1.

---

## Phase 1 — Compatibility Date Bump

Smallest and most isolated change: one line in `worker/wrangler.toml`, one preview smoke, one promote. Rollback is a one-line revert.

### Task 1.1: Create worktree and branch

**Files:** none (git only).

- [ ] **Step 1: Create a worktree from `origin/main`**

```bash
git fetch origin
git worktree add .worktrees/cf-compat-date -b cf-compat-date origin/main
cd .worktrees/cf-compat-date
```

Expected: new directory at `.worktrees/cf-compat-date` on branch `cf-compat-date` based on latest `origin/main`.

### Task 1.2: Review compatibility-flag changes since 2025-01-01

**Files:** none (research only).

- [ ] **Step 1: Review the Workers compatibility flag timeline**

Open `https://developers.cloudflare.com/workers/configuration/compatibility-flags/` and, for each flag below, **verify on the Cloudflare page** that it is listed with a default-on date ≤ 2026-04-18. If any flag is still default-off at our target date, reclassify it and re-evaluate. Expected state after verification:

- `nodejs_compat_populate_process_env` — default ≤ 2025-04-01 — makes `env` vars visible on `process.env` — we read env from the `Env` binding, not `process.env`, so neutral.
- `set_event_target_this` — default ≤ 2025-08-01 — fixes `this` binding on `EventTarget` — neutral for our handler code.
- `expose_global_message_channel` — default ≤ 2025-08-15 — exposes `MessageChannel` globally — not used.
- `enable_nodejs_http_modules` — default ≤ 2025-08-15 — Node compat; not invoked by the Worker.
- `enable_nodejs_http_server_modules` — default ≤ 2025-09-01 — Node compat; not invoked.
- `enable_nodejs_process_v2` — default ≤ 2025-09-15 — Node compat; not invoked.
- `enable_ctx_exports` — default ≤ 2025-11-17 — `ctx` binding exports; `ctx.waitUntil()` already available pre-flag.
- `containers_pid_namespace` — default ≤ 2026-04-01 — containers feature; not used.
- `web_socket_auto_reply_to_close` — default ≤ 2026-04-07 — WebSocket; not used.

**Acceptance check:** run `rg -n 'node:http|node:process|EventTarget|MessageChannel|new WebSocket' worker/src shared/lib` and confirm no matches that would be affected by these flag changes. Expected: empty or only test-fixture matches.

**Expected conclusion:** no breaking-change flags for our code surface. Additive enables only. If the grep surfaces a real call site, escalate — the flag may require code adjustment before the bump.

- [ ] **Step 2: Record the bump target date**

Record the commit date of the local `main` at the time of the bump. Use the exact string `"2026-04-18"` (today) for reproducibility. Do not set a future date.

### Task 1.3: Bump `compatibility_date` in wrangler.toml

**Files:** Modify `worker/wrangler.toml:3`.

- [ ] **Step 1: Edit the file**

Before:
```toml
compatibility_date = "2025-01-01"
```

After:
```toml
compatibility_date = "2026-04-18"
```

- [ ] **Step 2: Run the worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: exit 0. A change in compat date cannot break TypeScript types; this is defensive.

- [ ] **Step 3: Run the repo test suite**

```bash
cd .. && npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 4: Run the pre-push merge gate locally**

```bash
npm run test:merge-gate
```

Expected: the worker-impacting branch classifier triggers `cd worker && npx tsc --noEmit`, plus the full shared validate suite. Exit 0.

### Task 1.4: Upload a Worker preview version and smoke it

**Files:** none (wrangler CLI + smoke script).

- [ ] **Step 1: Upload the candidate Worker version**

```bash
cd worker && npx --no-install wrangler versions upload
```

Expected: wrangler prints a `Version ID:` and a Preview URL (`https://<version-id>-stablecoin-api.<account>.workers.dev`). Record both.

- [ ] **Step 2: Smoke the preview URL with the repo smoke script**

```bash
cd .. && SMOKE_API_BASE="https://<preview-url-from-step-1>" SMOKE_API_KEY="<local smoke token>" npm run test:smoke-api
```

Note: the env var is `SMOKE_API_BASE` (matches `scripts/smoke-api.mjs` and `.github/workflows/deploy-cloudflare.yml`). `SMOKE_API_URL` is silently ignored.

Expected: all smoke assertions pass against the preview host. If any request returns a runtime error that did not reproduce on the current production version, do not promote. Revert the compat date, commit the revert, re-run this task.

### Task 1.5: Commit and open PR

**Files:** `worker/wrangler.toml` (already edited).

- [ ] **Step 1: Commit**

```bash
git add worker/wrangler.toml
git commit -m "chore(worker): bump compatibility_date to 2026-04-18

Rolls forward 16 months of compatibility-flag defaults:
nodejs_compat_populate_process_env, set_event_target_this,
expose_global_message_channel, enable_nodejs_http_modules,
enable_nodejs_http_server_modules, enable_nodejs_process_v2,
enable_ctx_exports, containers_pid_namespace,
web_socket_auto_reply_to_close.

None of these flip behavior on code paths Pharos exercises
(Node HTTP client/server, containers, WebSocket — all unused;
env-on-process.env — not read). Preview smoke passed on
version <version-id>."
```

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin cf-compat-date
gh pr create --title "chore(worker): bump compatibility_date to 2026-04-18" --body "$(cat <<'EOF'
## Summary
- Bumps `worker/wrangler.toml` compatibility_date from `2025-01-01` to `2026-04-18`.
- Rolls forward compatibility-flag defaults; no breaking-change flags for code paths Pharos exercises.

## Verification
- Preview smoke on `https://<version-id>-stablecoin-api.<account>.workers.dev` — passes `npm run test:smoke-api`.
- Local merge gate passes.

## Rollback
- Revert this commit. Next deploy restores the prior date.
EOF
)"
```

Expected: PR created with the workflow validate gate triggered. Do not merge until CI is green and post-promote `smoke-api` against production completes.

### Task 1.6: Merge and observe production

**Files:** none.

- [ ] **Step 1: After PR merge, watch the deploy workflow**

```bash
gh run list --branch main --limit 1
gh run watch $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: `deploy-worker`, `smoke-api`, and `smoke-ops` all succeed. If `smoke-api` fails, the workflow auto-invokes `rollback-worker` (see `.github/workflows/deploy-cloudflare.yml`).

- [ ] **Step 2: Observe one cron cycle on production**

Let at least one full `*/15 * * * *` cycle complete after promote, then check `/api/status`:

```bash
curl -s https://api.pharos.watch/api/status -H "X-API-Key: ${SMOKE_API_KEY}" | jq '.crons[] | {name, status, last_ok}' | head -40
```

Expected: no new `error` status introduced on any cron after the bump. If a cron begins erroring due to a compat-flag behavior shift, revert the compat date (see Task 1.5 rollback).

---

## Phase 2 — WAF Zone-Level Rate Limiting Rule

Dashboard-only configuration. No code changes. The goal is an upstream flood filter that fires **before** Worker code runs, sparing Worker CPU and D1 limiter writes on clearly abusive traffic. This complements — does not replace — the Worker's per-IP and per-API-key rate limiters.

**Plan-level dependency:** confirmed plan level from Pre-Flight Step 1. If Free plan, the rule is constrained to 1 active rate-limiting rule, 10-second counting period only, and limited match fields. Paid plans unlock more fields, longer windows, and more rules.

### Task 2.1: Choose the rule parameters

**Files:** none (design only).

- [ ] **Step 1: Pick a conservative threshold**

Legitimate traffic estimates (from `site_data_request_stats`, `api_request_consumer_stats` — read via `GET /api/request-source-stats` on `ops-api.pharos.watch`):
- Peak per-IP on a busy minute: < 100 req/min from any single IP (most requests are one-per-coin-page).
- The cron `status-self-check` probes `api.pharos.watch` every 15 minutes → 4/hour — negligible.

**Chosen threshold:** `1000 requests / 10 seconds` per IP, action `block` with a 10-second duration. This is loose enough to never impact legitimate use yet tight enough to deflect a volumetric flood.

- [ ] **Step 2: Pick the match scope**

Target: zone `pharos.watch`, hostnames `api.pharos.watch`, `site-api.pharos.watch`, `ops-api.pharos.watch`. All three Worker subdomains.

Pattern (Cloudflare WAF expression syntax):
```
(http.host eq "api.pharos.watch") or (http.host eq "site-api.pharos.watch") or (http.host eq "ops-api.pharos.watch")
```

If the Free plan disallows `http.host` in rate-limiting rule match fields (unverified in docs), fall back to `starts_with(http.request.uri.path, "/api/")` — matches on every subdomain in the zone but is still safe because those subdomains are all API hosts.

- [ ] **Step 3: Pick the counting characteristic**

Characteristic: `ip.src` (counter-per-client-IP). This is the Cloudflare default for rate-limiting rules and does not require paid-plan add-ons.

### Task 2.2: Create the rule via Cloudflare Dashboard

**Files:** `docs/operator-origin-access.md` (updated in Task 2.3).

- [ ] **Step 1: Open the WAF rate-limiting rules editor**

Dashboard path: Cloudflare dashboard → zone `pharos.watch` → Security → WAF → Rate limiting rules → Create rule.

- [ ] **Step 2: Populate fields**

| Field | Value |
| --- | --- |
| Rule name | `flood-filter-api-hosts` |
| If incoming requests match | expression from Task 2.1 Step 2 |
| When rate exceeds | `1000` requests |
| Period | `10 seconds` |
| With the same characteristic | `ip.src` |
| Then take action | `Block` |
| For a duration of | `10 seconds` |
| (Optional) Response type | Default 429 |

If the plan surfaces a "managed challenge" option that is cheaper than block on the current plan, prefer `Managed challenge` — it lets legitimate users through after a browser check while still shedding non-browser flood traffic.

- [ ] **Step 3: Save and deploy**

Click Deploy. Record the rule id shown in the dashboard (visible in the URL or rule list). Needed for Task 2.4.

### Task 2.3: Update the operator runbook

**Files:** Modify `docs/operator-origin-access.md`.

- [ ] **Step 1: Add a new section after existing "Section 8. Rotate the site-data shared secret"**

Insertion point: immediately after Section 8's last line and **before** the horizontal-rule separator (`---`) at `docs/operator-origin-access.md:284`. This keeps the new Section 9 inside the same numbered-subsection block. The top-level `## Recommended Cloudflare Values` heading that follows the separator must stay below Section 9, not above it.

Insert:

```markdown
### 9. Maintain the WAF rate-limiting rule

Zone-level rate-limiting rule `flood-filter-api-hosts` deflects volumetric floods at the Cloudflare edge, before any Worker or D1 write happens. It complements — does not replace — `public_api_rate_limit` and `api_key_rate_limit` in the Worker.

Parameters of record:

- Match: `http.host in { api.pharos.watch, site-api.pharos.watch, ops-api.pharos.watch }`
- Threshold: `1000` requests / `10` seconds per `ip.src`
- Action: `Block` for `10` seconds

To edit or disable:

- Cloudflare dashboard → zone `pharos.watch` → Security → WAF → Rate limiting rules → `flood-filter-api-hosts`.

Operational notes:

- Legitimate per-IP peaks on the public API are well under 1000/10s. If a threshold bump is ever needed, change this single rule — do not add a second rule on the free plan, which allows only one active rate-limiting rule.
- Rule matches appear under Security Events filtered by `rule-id = <id>`. Track that page after each deploy for false positives.
- The Worker-side public-API limiter (see `docs/worker-infrastructure.md` → Edge Cache Strategy and Public API Auth and Rate Limiting) remains in force for per-key accuracy and persists across colos. The WAF rule is intentionally permissive.
```

- [ ] **Step 2: Commit the doc update on its own worktree branch**

```bash
git fetch origin
git worktree add .worktrees/cf-waf-rule -b cf-waf-rule origin/main
cd .worktrees/cf-waf-rule

# Apply the edit from Step 1 above into docs/operator-origin-access.md.

git add docs/operator-origin-access.md
git commit -m "docs(ops): document zone-level WAF rate-limiting rule for pharos API hosts

Adds Section 9 to operator-origin-access.md capturing rule parameters,
edit path, and the rule's operational relationship with the Worker-side
D1-backed limiter. Complements, does not replace, per-key accounting."
git push -u origin cf-waf-rule
```

### Task 2.4: Observe production after the rule goes live

**Files:** none.

- [ ] **Step 1: Watch Security Events for false positives for 24 hours**

Dashboard path: Cloudflare dashboard → zone `pharos.watch` → Security → Events → filter by Rule ID (from Task 2.2 Step 3).

Expected observation: near-zero matches during normal operation. If a legitimate consumer shows up (e.g. the Worker's own `status-self-check` or a friendly bot), either raise the threshold or add a narrower exception rule.

- [ ] **Step 2: Open the PR from Task 2.3 and merge**

```bash
gh pr create --title "docs(ops): document WAF rate-limiting rule for Pharos API hosts" --body "$(cat <<'EOF'
## Summary
- Documents the zone-level WAF rate-limiting rule `flood-filter-api-hosts` added via Cloudflare Dashboard.

## Context
- Rule deflects volumetric floods at the edge before Worker/D1 limiters see them.
- Complements `public_api_rate_limit` and `api_key_rate_limit` — does not replace them.

## Rollback
- Delete the rule in the Cloudflare dashboard and revert this commit.
EOF
)"
```

Expected: PR merges without CI touching Worker or Pages deploy surfaces (doc-only change takes the `no-deploy-required` path per `.github/workflows/deploy-cloudflare.yml`).

---

## Cross-Phase Summary Checklist

- [ ] Phase 1 (compat-date): PR merged, `smoke-api` green, one full cron cycle observed clean.
- [ ] Phase 2 (WAF rule): rule deployed via dashboard, Section 9 of `operator-origin-access.md` merged, 24h Security Events observed clean.
- [ ] Worktree cleanup after each phase's PR merges: `git worktree remove .worktrees/cf-compat-date`, `git worktree remove .worktrees/cf-waf-rule`. Drop local branches with `git branch -d <branch>` once merged.

## Rollback Matrix

| Phase | Rollback action | Rollback time |
| --- | --- | --- |
| 1 | Revert the single-line wrangler.toml commit, redeploy. | < 10 min |
| 2 | Disable or delete the `flood-filter-api-hosts` rule in Cloudflare Dashboard. | immediate |

## Out of Scope (deliberate)

- **Cloudflare AI Gateway** for Anthropic digest calls (see "Out of this plan" note at the top). Deferred until a second LLM caller appears or fallback-model routing becomes a concrete ask.
- **Cloudflare Secrets Store** adoption. Still open beta; revisit at GA.
- **D1 Read Replicas**, **Analytics Engine**, **Logpush to R2**, **native Rate Limiting binding**, **Turnstile** — all Tier 2 items in the original research report. Independent follow-ups.

## References

- `docs/worker-infrastructure.md` — env interface, cron scheduling, rate limiting context
- `docs/operator-origin-access.md` — zone/DNS/Access runbook
- `docs/worker-and-api-limits.md` — CPU/time budgets
- `memory/cloudflare_surface.md` — Cloudflare feature adoption inventory
- `worker/wrangler.toml` — routes, triggers, [vars], compat date
