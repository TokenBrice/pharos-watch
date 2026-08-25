# Incident: Google Safe Browsing flag on pharos.watch

Playbook for clearing a "Dangerous site" / "Deceptive content" / "Malware" warning shown in Chrome / Firefox / Safari for `pharos.watch` or any subdomain.

Past incident reference: 2026-05-12 flag for "Deceptive content / Social Engineering". Root cause was a root-layout inline `beforeInteractive` script whose static signature matched credential-harvesting phishing kits. Fix shipped in `3298b0bdc`, review submitted, cleared within 72h.

Durable rules from that incident live in `docs/security-governance.md`.

## TL;DR — first 30 minutes

1. Confirm the flag is real (not a single user's stale local cache): https://transparencyreport.google.com/safe-browsing/search?url=pharos.watch
2. Open Search Console → Security & Manual Actions → Security Issues. Note the **category** (Deceptive / Malware / Unwanted software / Harmful download) and click **VIEW RELATED MESSAGES** to read the email Google sent — that names the specific sample URL.
3. Identify the trigger on the named URL (see "Common triggers" below).
4. Harden, deploy, verify the new HTML is live on production via `curl`.
5. Submit review request in Search Console with a narrative referencing the fix commit.
6. Wait 24–72h. Public verdict will clear at the transparency report and in Chrome simultaneously.

Do NOT submit the review request before the hardening is live in production. If Google re-scans before the new HTML is on the CDN, the verdict won't change.

## Step-by-step

### Step 1 — Confirm the verdict is real

Cached browser warnings can persist for hours after a clear verdict, and individual users can get a flag if they have a poisoned local GSB list. Always verify against an authoritative source before assuming a flag is fresh:

- **Authoritative public lookup**: https://transparencyreport.google.com/safe-browsing/search?url=pharos.watch
- **Authoritative private**: Search Console → Security Issues (requires verified ownership of `pharos.watch` at `me@tokenbrice.com`)
- **Cross-check**: `npm run check:safe-browsing` (requires `GOOGLE_SAFE_BROWSING_API_KEY` env var)

If the transparency report shows "No unsafe content found" but Chrome still warns, it's a local cache. Wait 4–24h or have the user open a fresh profile. Do not proceed with the rest of this playbook.

### Step 2 — Identify the specific URL and category

Search Console → **Security & Manual Actions → Security Issues**.

The issues page itself may show `Sample URLs: N/A`. That is a UI quirk — the actual sample is in the email Google sent to the verified owner. Click **VIEW RELATED MESSAGES** to open that email. It contains:

- The exact URL(s) Google's classifier flagged
- The specific sub-category
- A `Learn more` link with the classifier's documentation

Common categories observed for pharos.watch–shaped sites:

| Category | What classifier looks for |
|---|---|
| Deceptive content / Social engineering | inline-script phishing signatures, forms that mimic credential collection, fake browser warnings, brand impersonation |
| Harmful download | binaries served from the site that AV vendors flag |
| Unwanted software | extension / wallet drainer patterns |
| Malware | JS that initiates malicious network behavior at runtime |

### Step 3 — Identify the trigger

Run a static scan against the live HTML of the flagged URL:

```bash
curl -sS https://pharos.watch/<path>/ -o /tmp/h.html
grep -c 'verify=\|__PHAROS_\|api-key-verify-url-sanitizer\|replaceState\|location\.hash' /tmp/h.html
```

If non-zero, the inline-script vector is the likely cause — see "Common triggers" below for category #1. If zero, check the other categories.

For the deceptive-content category specifically, build a mental model of what a classifier sees: rendered HTML + extracted text + form fields. Pages that mimic credential collection (even legitimately) are the highest-risk surface:

- **/api/** — API key request form (email, name, organization, project URL, use case, expected cadence/volume, terms checkbox, plus a hidden honeypot input)
- **/funding/** — wallet addresses + "support" + chain logos
- **/pharoswatchbot/** — Telegram bot integration page
- Any page with `password`, `seed phrase`, `private key`, `wallet connect`, `claim`, `airdrop` keywords

### Step 4 — Common triggers and surgical fixes

#### A. Inline-script phishing signatures (most common — 2026-05-12 root cause)

**Signature:** A `<script>` block in the HTML matching any of the CI guardrail's four independent phishing-kit patterns: `history.replaceState` near a credential keyword (`verify`/`token`/`auth`/`key`/`session`/`otp`/`magic`); `URLSearchParams(` over `location.hash`; a `window.__*_(TOKEN|KEY|SECRET|AUTH)__` global assignment; or the textbook `try{ … location.hash … replaceState … }catch` shape. Any single pattern is deploy-blocking. Especially dangerous when one of these is in a root layout and ships to every page.

**Fix:** Move the logic into a React effect that mounts on the specific route. Remove the inline script entirely. Token-in-URL discipline rule in `docs/security-governance.md` formalizes this.

**Verify:** `npm run check:phishing-signatures` after `npm run build`. Returns 0 if clean.

#### B. Credential-shaped form pattern

**Signature:** A form with email + password inputs (or seed-phrase-like patterns) on a non-login page; a "verify your account" CTA without backend context; a "claim your tokens" button.

**Fix:** Add a visible disclaimer at the top of the page stating what the form does and does not do — but word it positively. `npm run check:sensitive-page-copy` (chained into `npm run check:structural`) blocks the literal phrases `seed phrase`, `recovery phrase`, `private key`, `connect wallet`, `claim tokens`, `airdrop`, `sign message`, and browser-warning copy anywhere under `src/app/api`, `src/app/funding`, `src/app/pharoswatchbot`, or the `api-key-request-*` components, so a disclaimer that names those terms will fail the gate. Prefer e.g. "This form only collects contact and use-case details so we can issue a read-only API key. Pharos never asks for wallet credentials of any kind." Do not widen the guardrail's phrase list to make a disclaimer pass. Remove any visually-misleading button labels.

#### C. Brand / system-warning impersonation

**Signature:** UI elements styled to look like browser warnings (red banner with `⚠` and "click to fix"), fake antivirus screens, fake security badges from unverified third parties.

**Fix:** Tone down severe-warning UI. Use product-internal banners (yellow / amber) rather than browser-warning-style red. Remove any unverified "security verified" badges.

#### D. Third-party resource hijack

**Signature:** Cloudflare Pages serves a stale or compromised bundle; or a `<script src="…third-party…">` resource serves different content per-region; or DNS has been hijacked.

**Fix:** Check `curl -sSI https://pharos.watch/` for the expected Cloudflare `cf-ray`. Check that `_next/static/chunks/*` hashes match the latest build. Verify Cloudflare Pages deploy ID matches the latest commit. If hijacked, rotate Cloudflare API tokens, redeploy from clean state.

### Step 5 — Harden, ship, verify

1. Commit the hardening with a clear `refactor(security):` or `fix(security):` prefix referencing the incident date.
2. Publish through the protected PR gate. The production Pages workflow builds once, then runs `npm run check:pages-release` over the exact `out/` artifact — feature-flag inlining, direct-upload build size, `check:phishing-signatures`, and the static SEO gates.
3. Wait for the target-SHA Pages release to succeed and for the deployment-specific release-marker check to confirm that Cloudflare published that commit. A fixed sleep is not release evidence; see [Deployment Process](../deployment-process.md) for the standard release and post-publish gates.
4. Verify the target-SHA HTML is live:
   ```bash
   curl -sS https://pharos.watch/<flagged-path>/ -o /tmp/h.html
   wc -c /tmp/h.html
   # Re-run the trigger scan from Step 3; should return 0.
   ```
5. Cross-check the deployed `cf-ray` and timestamp to confirm you're not hitting a stale cache:
   ```bash
   curl -sSI https://pharos.watch/<flagged-path>/ | grep -E 'cf-ray|date|age'
   ```

### Step 6 — Submit the review request

Open Search Console → Security Issues → **REQUEST REVIEW**. Use this narrative skeleton:

```
Performed a security audit after Safe Browsing flagged pharos.watch as
<CATEGORY> on YYYY-MM-DD.

Identified cause: <one-paragraph technical description of what the
classifier was matching against, why it triggered, and why it is not
actually harmful>

Fix deployed:
- Commit <SHA> — <terse description>

Site purpose & integrity:
Pharos is an open-source stablecoin analytics dashboard
(https://github.com/TokenBrice/pharos-watch). No page collects
passwords, seed phrases, private keys, or wallet signatures. No
third-party advertising. No iframes or redirect chains. CSP is strict.
The flagged URL is a public analytics dashboard with no credential
collection. Please re-evaluate.
```

Be specific and technical. Vague "we've fixed it" submissions are queued behind detailed ones.

### Step 7 — Monitor the clear

- **Transparency report**: https://transparencyreport.google.com/safe-browsing/search?url=pharos.watch — updates the moment the verdict flips.
- **Search Console**: Security Issues page transitions from "1 issue detected" to "No issues" simultaneously.
- **Chrome local cache**: clears within a few hours of the verdict update. Users can force-clear via `chrome://safe-browsing` → "Update lists" or by waiting.

### Step 8 — Post-incident

Add lessons learned to `docs/security-governance.md` under the appropriate Rule. Update `scripts/ci/check-phishing-signatures.ts` if a new signature was identified. If the trigger was something the CI guardrails didn't catch, add a check.

## What not to do

- **Don't** submit multiple review requests in quick succession. Each one resets the queue position.
- **Don't** disable the flag locally and assume it's gone for everyone — the verdict is server-side.
- **Don't** redeploy without verifying the trigger is actually fixed in the new HTML. The classifier will re-flag on the same evidence.
- **Don't** strip out legitimate security measures (CSP, HSTS, JSON-LD) in an attempt to "look less complex" — that hurts classifier confidence.
- **Don't** chase exotic theories before checking the boring ones. The trigger is almost always either an inline-script signature or a credential-shaped form pattern.

## Reference links

- Google Safe Browsing transparency report: https://transparencyreport.google.com/safe-browsing/search?url=pharos.watch
- Safe Browsing API documentation: https://developers.google.com/safe-browsing/v4
- Search Console: https://search.google.com/search-console
- Anonymous false-positive report: https://safebrowsing.google.com/safebrowsing/report_error/
- Google's deceptive-content category docs: https://developers.google.com/search/docs/monitor-debug/security/social-engineering
