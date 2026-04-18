# Cloudflare Tier 1 Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt three low-risk, high-value Cloudflare platform improvements: (1) route Anthropic calls through Cloudflare AI Gateway, (2) bump the Workers `compatibility_date` from 2025-01-01 to current, (3) add a zone-level WAF rate-limiting rule as an upstream flood filter.

**Architecture:** Three independent phases shipped separately, each with its own rollback. Phase ordering by risk: compat-date bump → WAF rule → AI Gateway. Each phase lands on its own worktree, gets its own PR, and each PR smokes on a Worker preview URL before production promote. No phase depends on another; if any is abandoned, the others stand alone.

**Tech Stack:** Cloudflare Workers, Cloudflare Pages, Cloudflare D1, Cloudflare AI Gateway, Cloudflare WAF (Rate Limiting Rules), Wrangler Versions + Preview URLs, vitest, TypeScript.

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

**Expected output:** the account email + account id. Record the **account id** — needed in Phase 3 for the AI Gateway URL.

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

## Phase 3 — AI Gateway for Anthropic

Routes `worker/src/cron/digest/platform.ts:99` from `https://api.anthropic.com/v1/messages` through `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages`. Preserves the native Anthropic response shape, streams through transparently, and gains per-call telemetry (token usage, cost, error rates) without touching the digest business logic.

**Why a feature flag:** if the Gateway ever adds latency or a new error surface, we want a one-env-var rollback that restores direct `api.anthropic.com` calls without another deploy.

**Why `cf-aig-skip-cache: true`:** digest prompts are content-specific (fresh market snapshot per run) and not cacheable. Caching would poison replays.

### Task 3.1: Create the gateway in Cloudflare

**Files:** none (dashboard + secret setup).

- [ ] **Step 1: Create the gateway**

Dashboard path: Cloudflare dashboard → AI → AI Gateway → Create Gateway.

| Field | Value |
| --- | --- |
| Name | `pharos-digest` |
| Authenticated Gateway | `On` (requires `cf-aig-authorization` header — recommended for defense-in-depth) |
| Cache responses | `Off` (digest has no cacheable prompts; per-request `cf-aig-skip-cache` is a belt) |
| Rate limiting | `Off` for now (we have Anthropic-side and Worker-side limits already) |
| Log requests | `On` |
| Log response body | `On` |

Record the **Gateway ID** (shown on the gateway detail page). Needed for the Worker URL.

- [ ] **Step 2: Create a Cloudflare API token for the Gateway**

Dashboard path: Cloudflare profile → API Tokens → Create Token → custom template with permissions:
- Account → AI Gateway → Run (required)

Record the token. Treat as secret.

### Task 3.2: Create worktree

**Files:** none (git only).

- [ ] **Step 1: Create a worktree from `origin/main`**

```bash
git fetch origin
git worktree add .worktrees/cf-ai-gateway -b cf-ai-gateway origin/main
cd .worktrees/cf-ai-gateway
```

Expected: new worktree on branch `cf-ai-gateway`.

### Task 3.3: Add env keys to the Worker contract

**Files:** Modify `worker/src/lib/env.ts:1-46` (Env interface) and `worker/src/lib/env.ts:53-93` (`WORKER_OPTIONAL_ENV_KEYS`); Modify `worker/wrangler.toml` [vars].

- [ ] **Step 1: Extend the `Env` interface**

In `worker/src/lib/env.ts`, add three new optional fields to the `Env` interface — style matches existing optional keys (trailing `?:`). Insert after `ANTHROPIC_API_KEY?: string;` (line 21):

```typescript
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;
```

- [ ] **Step 2: Add the three keys to `WORKER_OPTIONAL_ENV_KEYS`**

Insert after the existing `"ANTHROPIC_API_KEY",` entry:

```typescript
  "AI_GATEWAY_ACCOUNT_ID",
  "AI_GATEWAY_ID",
  "AI_GATEWAY_TOKEN",
```

Do **not** add these to `validateWorkerEnvContract` — missing any of the three falls back cleanly to direct Anthropic (see `resolveAnthropicGatewayConfig` in Task 3.4), so no "partial config" warning is needed.

Do **not** touch the Pages Functions env contracts at `functions/lib/ops-env.ts`, `functions/lib/site-api-env.ts`, or the paired Pages runtime binding tables in `docs/worker-infrastructure.md:47`. AI Gateway is only consumed by the Worker's digest platform; Pages Functions never call Anthropic. Adding these keys to the Pages contracts would be dead surface area.

- [ ] **Step 3: Add account id + gateway id as public vars in wrangler.toml**

Account ids and gateway ids are not secret — they appear in Cloudflare dashboard URLs. Only the token is sensitive.

Modify `worker/wrangler.toml` `[vars]` block (lines 59-64) by appending:

```toml
AI_GATEWAY_ACCOUNT_ID = "<account-id-from-pre-flight>"
AI_GATEWAY_ID = "pharos-digest"
```

- [ ] **Step 4: Set the gateway token as a Worker secret**

```bash
cd worker && npx --no-install wrangler secret put AI_GATEWAY_TOKEN
```

Paste the token from Task 3.1 Step 2 when prompted. Verify via `npx --no-install wrangler secret list` that `AI_GATEWAY_TOKEN` is present.

- [ ] **Step 5: Commit env-contract changes only (no code change yet)**

```bash
git add worker/wrangler.toml worker/src/lib/env.ts
git commit -m "chore(worker): add AI Gateway env keys to worker contract (unwired)

Adds AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN to the
Env interface and WORKER_OPTIONAL_ENV_KEYS. Phase 3 of
cloudflare-tier1-adoption plan: keys land as optional so worker
still runs if any is missing. Subsequent commits wire the keys into
digest platform."
```

### Task 3.4: Add Gateway URL + header helpers with tests

**Files:** Create `worker/src/lib/ai-gateway.ts`; Create `worker/src/lib/__tests__/ai-gateway.test.ts`.

**Design note:** the helper splits into three concerns.
- `resolveAnthropicGatewayConfig(env)` — reads the three env keys and returns a typed config or `null` when **any** of the three (`AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`, `AI_GATEWAY_TOKEN`) is missing or blank. All three are required because the gateway is provisioned as **Authenticated** in Task 3.1 — a request without `cf-aig-authorization` returns 401 from Cloudflare before ever reaching Anthropic. Treating any missing key as "gateway off" is what makes the kill switch safe: removing any one of the three env vars reverts cleanly to direct `api.anthropic.com`.
- `buildAnthropicMessagesUrl(config)` — returns direct Anthropic URL when `config` is `null`, gateway URL otherwise.
- `buildGatewayHeaders(config, opts)` — returns **only** gateway-augmentation headers (`cf-aig-*`). The call site continues to own the Anthropic-native headers (`x-api-key`, `anthropic-version`, `Accept: text/event-stream`) and spreads gateway headers on top. This keeps the helper focused on gateway concerns and leaves streaming headers unaffected when the gateway is disabled.

- [ ] **Step 1: Write the failing test**

File: `worker/src/lib/__tests__/ai-gateway.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesUrl,
  buildGatewayHeaders,
  resolveAnthropicGatewayConfig,
} from "../ai-gateway";

describe("resolveAnthropicGatewayConfig", () => {
  it("returns null when all three env keys are missing", () => {
    expect(resolveAnthropicGatewayConfig({})).toBeNull();
  });

  it("returns null when account id is missing", () => {
    expect(
      resolveAnthropicGatewayConfig({ AI_GATEWAY_ID: "pharos-digest", AI_GATEWAY_TOKEN: "t" }),
    ).toBeNull();
  });

  it("returns null when gateway id is missing", () => {
    expect(
      resolveAnthropicGatewayConfig({ AI_GATEWAY_ACCOUNT_ID: "acc", AI_GATEWAY_TOKEN: "t" }),
    ).toBeNull();
  });

  it("returns null when token is missing (authenticated gateway requires cf-aig-authorization)", () => {
    expect(
      resolveAnthropicGatewayConfig({ AI_GATEWAY_ACCOUNT_ID: "acc", AI_GATEWAY_ID: "gw" }),
    ).toBeNull();
  });

  it("returns full config when all three are set", () => {
    expect(
      resolveAnthropicGatewayConfig({
        AI_GATEWAY_ACCOUNT_ID: "acc",
        AI_GATEWAY_ID: "gw",
        AI_GATEWAY_TOKEN: "t",
      }),
    ).toEqual({ accountId: "acc", id: "gw", token: "t" });
  });

  it("treats whitespace-only values as missing", () => {
    expect(
      resolveAnthropicGatewayConfig({
        AI_GATEWAY_ACCOUNT_ID: "  ",
        AI_GATEWAY_ID: "gw",
        AI_GATEWAY_TOKEN: "t",
      }),
    ).toBeNull();
  });
});

describe("buildAnthropicMessagesUrl", () => {
  it("returns the direct Anthropic URL when config is null", () => {
    expect(buildAnthropicMessagesUrl(null)).toBe("https://api.anthropic.com/v1/messages");
  });

  it("returns the AI Gateway URL when config is provided", () => {
    expect(
      buildAnthropicMessagesUrl({ accountId: "acc-123", id: "pharos-digest", token: null }),
    ).toBe("https://gateway.ai.cloudflare.com/v1/acc-123/pharos-digest/anthropic/v1/messages");
  });
});

describe("buildGatewayHeaders", () => {
  it("returns an empty object when config is null", () => {
    expect(buildGatewayHeaders(null, { skipCache: true })).toEqual({});
  });

  it("adds cf-aig-authorization and cf-aig-skip-cache when config is set and skipCache=true", () => {
    expect(
      buildGatewayHeaders({ accountId: "acc", id: "gw", token: "t" }, { skipCache: true }),
    ).toEqual({ "cf-aig-authorization": "Bearer t", "cf-aig-skip-cache": "true" });
  });

  it("omits cf-aig-skip-cache when skipCache is false", () => {
    expect(
      buildGatewayHeaders({ accountId: "acc", id: "gw", token: "t" }, { skipCache: false }),
    ).toEqual({ "cf-aig-authorization": "Bearer t" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd worker && npx vitest run src/lib/__tests__/ai-gateway.test.ts
```

Expected: test fails with "Cannot find module '../ai-gateway'".

- [ ] **Step 3: Create the helper**

File: `worker/src/lib/ai-gateway.ts`

```typescript
const DIRECT_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface AnthropicGatewayConfig {
  accountId: string;
  id: string;
  token: string;
}

interface GatewayEnv {
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;
}

function trimOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveAnthropicGatewayConfig(env: GatewayEnv): AnthropicGatewayConfig | null {
  const accountId = trimOrNull(env.AI_GATEWAY_ACCOUNT_ID);
  const id = trimOrNull(env.AI_GATEWAY_ID);
  const token = trimOrNull(env.AI_GATEWAY_TOKEN);
  if (!accountId || !id || !token) return null;
  return { accountId, id, token };
}

export function buildAnthropicMessagesUrl(config: AnthropicGatewayConfig | null): string {
  if (!config) return DIRECT_ANTHROPIC_URL;
  return `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.id}/anthropic/v1/messages`;
}

export function buildGatewayHeaders(
  config: AnthropicGatewayConfig | null,
  opts: { skipCache: boolean },
): Record<string, string> {
  if (!config) return {};
  const headers: Record<string, string> = {
    "cf-aig-authorization": `Bearer ${config.token}`,
  };
  if (opts.skipCache) headers["cf-aig-skip-cache"] = "true";
  return headers;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd worker && npx vitest run src/lib/__tests__/ai-gateway.test.ts
```

Expected: all assertions pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/ai-gateway.ts worker/src/lib/__tests__/ai-gateway.test.ts
git commit -m "feat(worker): add AI Gateway URL and header helpers

Three pure functions: resolveAnthropicGatewayConfig reads env
(returns null if AI_GATEWAY_ACCOUNT_ID or AI_GATEWAY_ID missing),
buildAnthropicMessagesUrl returns direct Anthropic URL on null
config otherwise the gateway URL, buildGatewayHeaders returns only
cf-aig-* augmentation headers for spreading on top of the existing
Anthropic-native headers. Helpers unused by digest call site yet
— next commit wires them in so a missing env var cleanly falls
back to direct Anthropic."
```

### Task 3.5: Wire helpers into digest platform and its callers

**Files:** Modify `worker/src/cron/digest/platform.ts:17-27` (`RequestDigestCopyOptions`), `worker/src/cron/digest/platform.ts:95-135` (the `fetchWithRetry` call site); Modify `worker/src/cron/daily-digest.ts` (signature + `requestDigestCopy` call); Modify `worker/src/cron/weekly-recap.ts` (signature + `requestDigestCopy` call); Modify `worker/src/handlers/scheduled/daily-0805.ts`, `worker/src/handlers/scheduled/digest-trigger-poll.ts` (to pass resolved gateway config into the digest/recap calls).

**Threading design:** add a single optional trailing parameter `anthropicGateway: AnthropicGatewayConfig | null` to `generateDailyDigest`, `generateWeeklyRecap`, and to `RequestDigestCopyOptions`. Scheduled handlers call `resolveAnthropicGatewayConfig(runtime.env)` once and pass the result down. Existing tests that omit the parameter keep working unchanged.

- [ ] **Step 1: Extend `RequestDigestCopyOptions`**

In `worker/src/cron/digest/platform.ts` (interface at lines 17-27), add one field after `anthropicApiKey`:

```typescript
  anthropicGateway?: AnthropicGatewayConfig | null;
```

Add the import at the top of the file:

```typescript
import type { AnthropicGatewayConfig } from "../../lib/ai-gateway";
import { buildAnthropicMessagesUrl, buildGatewayHeaders } from "../../lib/ai-gateway";
```

- [ ] **Step 2: Update the `fetchWithRetry` call site in `requestDigestCopy`**

In `worker/src/cron/digest/platform.ts` at the `requestClaude` inner function (around line 97-135), replace the URL and headers. Preserve `fetchWithRetry`, the retry/timeout args, and the original Anthropic-native headers including `Accept: text/event-stream`.

Before:
```typescript
const response = await fetchWithRetry(
  "https://api.anthropic.com/v1/messages",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({
      // ... unchanged body ...
    }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)])
      : AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  },
  DIGEST_FETCH_MAX_RETRIES,
  { timeoutMs: DIGEST_FETCH_PER_ATTEMPT_TIMEOUT_MS },
);
```

After:
```typescript
const gateway = options.anthropicGateway ?? null;
const response = await fetchWithRetry(
  buildAnthropicMessagesUrl(gateway),
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Accept": "text/event-stream",
      ...buildGatewayHeaders(gateway, { skipCache: true }),
    },
    body: JSON.stringify({
      // ... unchanged body ...
    }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)])
      : AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  },
  DIGEST_FETCH_MAX_RETRIES,
  { timeoutMs: DIGEST_FETCH_PER_ATTEMPT_TIMEOUT_MS },
);
```

Body (`JSON.stringify({ model, max_tokens, thinking, output_config, system, messages, stream })`) is unchanged — the AI Gateway native Anthropic endpoint is a request/response passthrough.

- [ ] **Step 3: Update `generateDailyDigest` signature**

In `worker/src/cron/daily-digest.ts`, add a trailing optional parameter to `generateDailyDigest`. Current signature (from the test fixture comment `(db, anthropicApiKey, twitterCreds, force, telegramCreds, signal)`):

```typescript
export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null,
  force: boolean,
  telegramCreds: TelegramCreds | null,
  signal: AbortSignal,
  anthropicGateway?: AnthropicGatewayConfig | null,   // new optional trailing param
): Promise<CronResult>
```

Add the import:
```typescript
import type { AnthropicGatewayConfig } from "../lib/ai-gateway";
```

Then in the `requestDigestCopy({ ... })` call at line 86, pass `anthropicGateway`:
```typescript
const digestCopy = await requestDigestCopy({
  db,
  anthropicApiKey,
  anthropicGateway: anthropicGateway ?? null,
  systemPrompt: SYSTEM_PROMPT,
  // ... rest unchanged
});
```

- [ ] **Step 4: Update `generateWeeklyRecap` signature**

In `worker/src/cron/weekly-recap.ts`, add a trailing optional parameter to `generateWeeklyRecap`. Current signature (from `worker/src/handlers/scheduled/daily-0805.ts:34-40`):

```typescript
export async function generateWeeklyRecap(
  db: D1Database,
  anthropicApiKey: string | null,
  telegramCreds: TelegramCreds | null,
  signal: AbortSignal,
  anthropicGateway?: AnthropicGatewayConfig | null,   // new optional trailing param
): Promise<CronResult>
```

Note: the existing signature has **four** positional args (no `twitterCreds`, no `force` — those are specific to daily). Add the import:

```typescript
import type { AnthropicGatewayConfig } from "../lib/ai-gateway";
```

Then at the `requestDigestCopy` call at line 566, pass `anthropicGateway`:

```typescript
const digestCopy = await requestDigestCopy({
  db,
  anthropicApiKey,
  anthropicGateway: anthropicGateway ?? null,
  systemPrompt: WEEKLY_SYSTEM_PROMPT,
  // ... rest unchanged
});
```

- [ ] **Step 5: Update scheduled-handler call sites**

Two files hold all the callers; both are short and tightly scoped.

**`worker/src/handlers/scheduled/daily-0805.ts`** — one `generateDailyDigest` call at lines 24-31 and one `generateWeeklyRecap` call at lines 34-40. Resolve the gateway config once at the top of `runDaily0805Slot`, then pass it as the new trailing arg to each:

```typescript
import { resolveAnthropicGatewayConfig } from "../../lib/ai-gateway";

export async function runDaily0805Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  const anthropicGateway = resolveAnthropicGatewayConfig(runtime.env);

  await Promise.all([
    runBestEffortScheduledJob(runtime, "daily 08:05 slot", "sync-bluechip", (signal) => syncBluechip(runtime.db, signal)),
    (async () => {
      await runBestEffortScheduledJob(runtime, "daily 08:05 slot", "daily-digest", (signal) => {
        return generateDailyDigest(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          null,
          false,
          buildTelegramCreds(runtime.env),
          signal,
          anthropicGateway,  // new trailing arg
        );
      });
      await runBestEffortScheduledJob(runtime, "daily 08:05 slot", "weekly-recap", (signal) => {
        return generateWeeklyRecap(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          buildTelegramCreds(runtime.env),
          signal,
          anthropicGateway,  // new trailing arg
        );
      });
    })(),
    runBestEffortScheduledJob(runtime, "daily 08:05 slot", "discovery-scan", (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey)),
  ]);
}
```

**`worker/src/handlers/scheduled/digest-trigger-poll.ts`** — one `generateDailyDigest` call at lines 57-64. Same pattern: resolve once near the top of the handler, pass as trailing arg:

```typescript
import { resolveAnthropicGatewayConfig } from "../../lib/ai-gateway";

// inside the poll handler, after the payload check:
const anthropicGateway = resolveAnthropicGatewayConfig(runtime.env);

result = await runtime.runLeasedCron("daily-digest", (signal) =>
  generateDailyDigest(
    runtime.db,
    runtime.env.ANTHROPIC_API_KEY ?? null,
    null,
    true,
    buildTelegramCreds(runtime.env),
    signal,
    anthropicGateway,  // new trailing arg
  ),
);
```

**Verification grep (run after edits):**

```bash
rg -n 'generateDailyDigest\(|generateWeeklyRecap\(' worker/src --glob '!__tests__'
```

Expected: exactly two `generateDailyDigest` call sites (daily-0805.ts:24, digest-trigger-poll.ts:57) and one `generateWeeklyRecap` call site (daily-0805.ts:34). All three now pass `anthropicGateway`.

- [ ] **Step 6: Update existing tests that stub these functions**

Test files that exercise the digest or scheduled digest path (confirmed via `rg -l 'generateDailyDigest|generateWeeklyRecap|requestDigestCopy' worker/src`):

- `worker/src/cron/digest/__tests__/*.test.ts`
- `worker/src/cron/__tests__/daily-digest.test.ts`
- `worker/src/cron/__tests__/weekly-recap.test.ts`
- `worker/src/handlers/scheduled/__tests__/digest-trigger-poll.test.ts`
- `worker/src/__tests__/index.scheduled.test.ts` (mocks `generateDailyDigest` and `generateWeeklyRecap` as `vi.fn()`)

For each test that calls `requestDigestCopy(...)`, `generateDailyDigest(...)`, or `generateWeeklyRecap(...)`:

- If the test does not care about gateway behavior, **omit the trailing arg** — the parameter is optional. Existing positional call-site tests (e.g. `generateDailyDigest(db, "anthropic-key")`) stay correct because the new param is trailing.
- If a test asserts on `mock.calls[N]` positional indexes, verify the indices still line up (they do — the trailing param only adds slot 7; existing assertions reference slots 0-5).

Add one new test file `worker/src/cron/digest/__tests__/platform-gateway.test.ts` (create) that calls `requestDigestCopy` with a populated `anthropicGateway` and verifies the wired URL + headers.

**Use the existing project mocking pattern from `worker/src/cron/__tests__/weekly-recap.test.ts:1-20,54-74`** — do not invent a new one. That test mocks `fetch-retry`, `telegram`, and `circuit-breaker`, and builds a proper multi-event SSE body via a `mockAnthropicStreamResponse(text)` helper. `requestDigestCopy` gates on `shouldAttemptFetch` (D1-backed) and parses the stream as a JSON digest payload; without those mocks and without a JSON-valid digest body, the test throws before ever reaching `fetchWithRetry` call-site inspection.

Concrete skeleton — copy the imports and helpers from `weekly-recap.test.ts:1-20,54-74` verbatim, then add the assertion-style below:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockTableConfig } from "../../../api/__tests__/helpers/mock-d1";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async () => {}),
}));

import { requestDigestCopy } from "../platform";
import { fetchWithRetry } from "../../../lib/fetch-retry";

// Copy mockAnthropicStreamResponse verbatim from
// worker/src/cron/__tests__/weekly-recap.test.ts:54-74

// Build a minimal JSON-valid digest stream body — structure must match
// what parseDigestModelResponse accepts. Use the same pattern as
// weekly-recap.test.ts's weeklyClaudeResponse() or daily-digest.test.ts's
// equivalent daily builder. The exact JSON shape is load-bearing;
// lift it from whichever sibling test is closest to your validationProfile.

describe("requestDigestCopy with AI Gateway config", () => {
  let db: D1Database;

  beforeEach(() => {
    const tables: MockTableConfig[] = [];
    db = mockD1(tables).database;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("routes through gateway URL and adds cf-aig-* headers on top of Anthropic-native headers", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(mockAnthropicStreamResponse(
      // use the same JSON digest body shape as the sibling test you mirrored
      JSON.stringify({ /* validationProfile-matching digest JSON here */ }),
    ));

    await requestDigestCopy({
      db,
      anthropicApiKey: "sk-ant-abc",
      anthropicGateway: { accountId: "acc-x", id: "gw-y", token: "tok-z" },
      systemPrompt: "sys",
      userPrompt: "user",
      maxTokens: 100,
      logPrefix: "test",
      // include parseOptions/validationProfile if the sibling test you mirrored sets them
    });

    const [url, init] = vi.mocked(fetchWithRetry).mock.calls[0];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/acc-x/gw-y/anthropic/v1/messages");
    const headers = init?.headers as Record<string, string>;
    expect(headers["cf-aig-authorization"]).toBe("Bearer tok-z");
    expect(headers["cf-aig-skip-cache"]).toBe("true");
    expect(headers["x-api-key"]).toBe("sk-ant-abc");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Accept"]).toBe("text/event-stream");
  });
});
```

If a sibling test (`daily-digest.test.ts` or `weekly-recap.test.ts`) exposes its digest-JSON builder as an exported helper, reuse it; otherwise inline a minimal copy. Do **not** try to run `requestDigestCopy` with `db: {} as D1Database` or a missing circuit-breaker mock — `shouldAttemptFetch` will throw before the fetch is reached.

- [ ] **Step 7: Run the worker test suite**

```bash
cd worker && npx vitest run
```

Expected: all pass (new gateway-wiring test plus untouched existing tests).

- [ ] **Step 8: Run the repo-wide merge gate**

```bash
cd .. && npm run test:merge-gate
```

Expected: exit 0. Worker typecheck + vitest + shared validate.

- [ ] **Step 9: Commit**

```bash
git add worker/src/cron/digest/platform.ts worker/src/cron/daily-digest.ts worker/src/cron/weekly-recap.ts worker/src/cron/digest/__tests__ worker/src/cron/__tests__ worker/src/handlers/scheduled/daily-0805.ts worker/src/handlers/scheduled/digest-trigger-poll.ts worker/src/handlers/scheduled/__tests__
git commit -m "feat(worker): route Anthropic calls through Cloudflare AI Gateway

Digest platform now spreads buildGatewayHeaders(...) onto the
existing Anthropic-native headers and uses buildAnthropicMessagesUrl
for the fetch URL. When AI_GATEWAY_ACCOUNT_ID + AI_GATEWAY_ID are
set (resolveAnthropicGatewayConfig returns non-null), the call flows
through gateway.ai.cloudflare.com/v1/.../anthropic/v1/messages with
cf-aig-authorization and cf-aig-skip-cache: true. Missing either id
returns null config and falls back to direct api.anthropic.com, so
the deploy remains safe even if the gateway vars are unset.

Streaming (Accept: text/event-stream), request body, response body,
and anthropic-version header are unchanged. Retry budget and
per-attempt timeout in fetchWithRetry are unchanged. The ANTHROPIC
circuit breaker keys by upstream dependency, not URL, so it still
trips correctly.

Telemetry and cost per call surface in the AI Gateway dashboard
(pharos-digest) instead of requiring log parsing."
```

### Task 3.6: Update env and infrastructure docs

**Files:** Modify `docs/worker-infrastructure.md`; Modify `docs/digest-pipeline.md`.

- [ ] **Step 1: Add new env rows to the `Env Interface` table in `docs/worker-infrastructure.md`**

Insert after the existing `ANTHROPIC_API_KEY` row:

```markdown
| `AI_GATEWAY_ACCOUNT_ID`          | string     | No                                                 | Cloudflare account id for the AI Gateway route; pairs with `AI_GATEWAY_ID`. Missing either falls back to direct `api.anthropic.com`. Set as `[vars]` in `worker/wrangler.toml`. |
| `AI_GATEWAY_ID`                  | string     | No                                                 | Cloudflare AI Gateway id (`pharos-digest`). Paired with `AI_GATEWAY_ACCOUNT_ID`. Set as `[vars]` in `worker/wrangler.toml`.                                                      |
| `AI_GATEWAY_TOKEN`               | string     | No                                                 | Bearer token for the authenticated AI Gateway. Provisioned via `wrangler secret put`. Absence falls back to direct Anthropic; presence activates `cf-aig-authorization`.        |
```

- [ ] **Step 2: Add an "AI Gateway" subsection to the digest section of `docs/digest-pipeline.md`**

Append to the runtime section:

```markdown
### AI Gateway

Anthropic calls from `daily-digest` and `weekly-recap` route through Cloudflare AI Gateway (`pharos-digest`) when `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID` are both set in the Worker's `[vars]`. Missing either falls back to direct `https://api.anthropic.com/v1/messages`.

The gateway adds:

- per-call token usage, cost, and error telemetry in the AI Gateway dashboard
- optional fallback models and retries if later configured on the gateway (currently off — Anthropic circuit breaker and in-worker retries are unchanged)

Every call sets `cf-aig-skip-cache: true` because digest prompts are content-specific and must not replay a cached response on retry. Authenticated gateway requires `AI_GATEWAY_TOKEN` (Worker secret) which the helper injects as `cf-aig-authorization: Bearer <token>`.

Kill switch: remove either `AI_GATEWAY_ACCOUNT_ID` or `AI_GATEWAY_ID` from `worker/wrangler.toml` `[vars]` and redeploy — the digest platform falls back to the direct Anthropic URL without a code change.
```

- [ ] **Step 3: Commit the doc updates**

```bash
git add docs/worker-infrastructure.md docs/digest-pipeline.md
git commit -m "docs: document AI Gateway adoption for Anthropic digest calls"
```

### Task 3.7: Standalone gateway smoke plus preview upload

Cron triggers do not fire on preview URLs and the digest is too heavy to rehearse end-to-end. Instead, use two cheap, independent smokes: (a) a one-shot curl against the gateway URL to verify authentication + passthrough; (b) the standard `npm run test:smoke-api` against a preview-uploaded Worker version to verify the Worker still boots and serves the public API after the code change.

**Files:** none (shell + dashboard).

- [ ] **Step 1: Gateway passthrough smoke via curl**

From any shell (does not require Worker deployment):

```bash
curl -sS -X POST "https://gateway.ai.cloudflare.com/v1/<account-id>/pharos-digest/anthropic/v1/messages" \
  -H "cf-aig-authorization: Bearer $AI_GATEWAY_TOKEN" \
  -H "cf-aig-skip-cache: true" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"Say hi."}]}' | jq '{stop_reason, model, usage, content}'
```

Expected output:
- HTTP 200
- `stop_reason` is `"end_turn"` or `"max_tokens"` (either is fine for a smoke)
- `model` starts with `"claude-haiku-4-5"`
- `usage.input_tokens` > 0 and `usage.output_tokens` > 0
- `content[0].text` contains a short greeting

If the request returns 401 from Cloudflare, the gateway `cf-aig-authorization` token is wrong. If it returns 401 from Anthropic, the `x-api-key` is wrong. If it returns any other non-200, do **not** proceed with the Worker change.

- [ ] **Step 2: Confirm the call appears in the AI Gateway dashboard**

Dashboard path: AI → AI Gateway → `pharos-digest` → Logs.

Expected: one entry with provider `anthropic`, status `200`, populated `tokens.total`, log body showing the greeting request. This confirms logging is active and the gateway is correctly bound to the provider.

- [ ] **Step 3: Upload the candidate Worker version**

```bash
cd worker && npx --no-install wrangler versions upload
```

Expected: wrangler prints `Version ID:` and a Preview URL. Record both.

- [ ] **Step 4: Smoke the preview URL**

```bash
cd .. && SMOKE_API_BASE="https://<preview-url>" SMOKE_API_KEY="<local smoke token>" npm run test:smoke-api
```

Note: env var name is `SMOKE_API_BASE` (see `scripts/smoke-api.mjs`). `SMOKE_API_URL` is ignored.

Expected: all public-API smoke assertions pass against the preview. This verifies the Worker still boots with the new env-contract entries and the digest-touching code changes did not regress non-digest code paths. The digest itself is not exercised here — that is validated post-promote by observing the next `5 8 * * *` UTC run.

### Task 3.8: Promote and observe

**Files:** none.

- [ ] **Step 1: Push, open PR, merge**

```bash
git push -u origin cf-ai-gateway
gh pr create --title "feat(worker): route Anthropic via Cloudflare AI Gateway" --body "$(cat <<'EOF'
## Summary
- Digest platform now calls Anthropic via `gateway.ai.cloudflare.com/v1/{account}/pharos-digest/anthropic/v1/messages` when `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID` are set.
- Falls back to direct `api.anthropic.com` if either is missing — kill switch is removing one env var and redeploying.
- `cf-aig-skip-cache: true` on every call; digest prompts are content-specific.

## Telemetry
- Per-call tokens, cost, latency now visible in Cloudflare AI Gateway dashboard (`pharos-digest`).

## Verification
- Unit tests on URL + header builder.
- Local remote rehearsal of the scheduled path — gateway dashboard shows 200 from Anthropic.

## Rollback
- Remove `AI_GATEWAY_ACCOUNT_ID` or `AI_GATEWAY_ID` from `worker/wrangler.toml` `[vars]` and redeploy.
EOF
)"
```

Expected: PR passes CI, deploys through the standard `deploy-worker` → `smoke-api` path.

- [ ] **Step 2: After promote, wait for the next scheduled digest run**

Daily digest fires at `5 8 * * *` UTC. After that run completes, inspect:

```bash
curl -s "https://ops-api.pharos.watch/api/status" -H "CF-Access-Client-Id: $OPS_SMOKE_CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $OPS_SMOKE_CF_ACCESS_CLIENT_SECRET" | jq '.crons[] | select(.name == "daily-digest")'
```

Expected: `status: "ok"`, `last_ok` timestamp post-promote. Cross-check with AI Gateway dashboard — the corresponding Anthropic call must appear.

- [ ] **Step 3: Record observed outcomes in memory**

If AI Gateway surfaces new useful facts (e.g., token usage per run, any latency shift vs. direct calls, any gateway-specific error), append to `memory/cloudflare_surface.md` under the `In use` section.

---

## Cross-Phase Summary Checklist

- [ ] Phase 1 (compat-date): PR merged, `smoke-api` green, one full cron cycle observed clean.
- [ ] Phase 2 (WAF rule): rule deployed via dashboard, Section 9 of `operator-origin-access.md` merged, 24h Security Events observed clean.
- [ ] Phase 3 (AI Gateway): PR merged, first post-promote daily digest run recorded in AI Gateway dashboard with matching `cron_runs` entry.
- [ ] Worktree cleanup after each phase's PR merges: `git worktree remove .worktrees/cf-compat-date`, `git worktree remove .worktrees/cf-waf-rule`, `git worktree remove .worktrees/cf-ai-gateway`. Drop local branches with `git branch -d <branch>` once merged.

## Rollback Matrix

| Phase | Rollback action | Rollback time |
| --- | --- | --- |
| 1 | Revert the single-line wrangler.toml commit, redeploy. | < 10 min |
| 2 | Disable or delete the `flood-filter-api-hosts` rule in Cloudflare Dashboard. | immediate |
| 3 | Remove `AI_GATEWAY_ACCOUNT_ID` or `AI_GATEWAY_ID` from `[vars]` in `worker/wrangler.toml`, redeploy. | < 10 min |

## Out of Scope (deliberate)

- AI Gateway per-request **fallback model configuration** (e.g. Opus → Sonnet). Not adopted in this plan; requires a separate change to the gateway config and is worth evaluating only after Phase 3 telemetry reveals whether Opus overload is the actual failure mode.
- AI Gateway **caching** for any endpoint. Digest must not cache; other LLM callers do not yet exist.
- **Cloudflare Secrets Store** adoption. Still open beta; revisit at GA.
- **D1 Read Replicas**, **Analytics Engine**, **Logpush to R2**, **native Rate Limiting binding**, **Turnstile** — all Tier 2 items in the original research report. Independent follow-ups.

## References

- `docs/worker-infrastructure.md` — env interface, cron scheduling, rate limiting context
- `docs/digest-pipeline.md` — digest cadence, retry/timeout model
- `docs/operator-origin-access.md` — zone/DNS/Access runbook
- `docs/worker-and-api-limits.md` — CPU/time budgets
- `memory/cloudflare_surface.md` — Cloudflare feature adoption inventory
- `worker/wrangler.toml` — routes, triggers, [vars], compat date
- `worker/src/cron/digest/platform.ts` — Anthropic call site
- `worker/src/lib/env.ts` — Env contract
