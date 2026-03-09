---
title: "Harden CI/CD pipeline and fix documentation inaccuracies"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Pin GitHub Actions to SHA hashes, fix stale documentation counts/symbols, and create .env.example for developer onboarding.

## Context

**Research findings addressed:**
- R7 Finding I2: GitHub Actions not pinned to immutable SHAs
- R8 Finding D1: Cron job count understated (19 vs actual 20)
- R8 Finding D2: Yield wrapper symbols drifted
- R7 Finding M2: No .env.example for worker secrets

## Task

### 1. Pin GitHub Actions to SHA hashes

In `.github/workflows/deploy-cloudflare.yml`, replace tag-based action references with their SHA-pinned equivalents. For each action:

1. Look up the current tag's SHA on GitHub (e.g., `actions/checkout@v4` → find the latest v4 commit SHA)
2. Replace the tag with the full SHA + a comment noting the version

Example format:
```yaml
- uses: actions/checkout@<sha>  # v4.2.2
```

Actions to pin:
- `actions/checkout@v4`
- `actions/setup-node@v4`
- `cloudflare/wrangler-action@v3`

Use these SHAs (look up the latest on GitHub, but these should be close):
- `actions/checkout` v4: `11bd71901bbe5b1630ceea73d27597364c9af683`
- `actions/setup-node` v4: `cdca7365b2dadb8aad0a33bc7601856ffabcc48e`
- `cloudflare/wrangler-action` v3: `fef56d74e3f01b9fc1af0e1de4bbef5c0e74adcb`

Verify the exact SHAs by checking the latest tag on each repo before committing.

### 2. Fix cron job count in docs

In `docs/worker-infrastructure.md`, find the line stating "19 primary cron jobs" (should be near line 3 or in the overview section) and update to "20 primary cron jobs". Add a note about the `dispatch-telegram-alerts-daily` job running on the 08:00 UTC trigger and the `snapshot-supply` retry on the quarter-hour trigger.

### 3. Fix yield wrapper symbols in docs

In `docs/yield-intelligence.md` (~line 95-118 in the wrapper map table):
- Update Yuzu USD wrapper symbol from `sYUSD` to `syzUSD`
- Update Main Street USD wrapper symbol from `sUSDM` to `msY`

Cross-reference with `worker/src/cron/yield-config.ts` lines 126-130 and 147-151 to confirm the correct symbols.

### 4. Create .env.example

Create a new file `.env.example` (or `worker/.env.example`) that lists all environment variables from the `Env` interface in `worker/src/lib/env.ts`. Format:

```bash
# Required secrets (set via `wrangler secret put`)
ADMIN_KEY=
FEEDBACK_IP_SALT=
COINGECKO_API_KEY=
GITHUB_PAT=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
OPENAI_API_KEY=
CMC_API_KEY=

# Worker vars (set in wrangler.toml [vars])
CORS_ORIGIN=https://pharos.watch
SELF_URL=https://api.pharos.watch
```

Review `worker/src/lib/env.ts` for the complete list. Group into "secrets" (should be in Cloudflare secrets, never in wrangler.toml) vs "vars" (safe to put in wrangler.toml). Include comments explaining which are required vs optional.

## Files Modified

- `.github/workflows/deploy-cloudflare.yml`
- `docs/worker-infrastructure.md`
- `docs/yield-intelligence.md`
- `.env.example` (new)

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep '@v[0-9]' .github/workflows/deploy-cloudflare.yml` returns nothing (all actions pinned to SHAs)
- `grep '20 primary' docs/worker-infrastructure.md` confirms updated count
- `grep 'syzUSD' docs/yield-intelligence.md` confirms corrected symbol
- `grep 'msY' docs/yield-intelligence.md` confirms corrected symbol
- `.env.example` exists and lists all env vars from `worker/src/lib/env.ts`
