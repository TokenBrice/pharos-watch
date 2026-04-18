# Deploy Pipeline Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four gaps in the deploy pipeline — redundant node-compat job, 2-dot vs 3-dot diff inconsistency, no PR-time secret scan, and no automated Pages rollback — without changing the existing deploy/merge-gate contract.

**Architecture:** Four independent tracks with surgical edits. Track A removes dead weight. Track D aligns diff semantics (fixes a latent correctness bug on rebased PRs with moving `main`). Track C adds a PR gitleaks job mirroring the weekly workflow. Track B inlines a best-effort `capture` step into the existing `deploy-pages` job (same shape as the worker path's `upload-worker-version`) and adds a sibling `rollback-pages` job to `pages-publish.yml`, calling the Cloudflare Pages rollback REST API via a new `scripts/rollback-pages-deployment.mjs` helper (no wrangler command exists for this).

**Tech Stack:** GitHub Actions, Node 25, wrangler 4.83.0, gitleaks 8.30.0, vitest 4.1, Cloudflare Pages REST API.

---

## File Structure

**Modify:**
- `.github/workflows/validate-ci.yml` — drop `validate-node25-compat` job (Track A).
- `.github/workflows/pull-request-checks.yml` — add `gitleaks` job scanning PR commit range (Track C).
- `.github/workflows/pages-publish.yml` — inline a best-effort `capture` step into `deploy-pages`, expose `previous_deployment_id` as a job output, and add a `rollback-pages` sibling job (Track B).
- `scripts/classify-deploy-changes.mjs:51` — change `${baseSha}..${headSha}` to `${baseSha}...${headSha}` (Track D).
- `scripts/check-critical-coverage.mjs:50` — change `${ref}..HEAD` to `${ref}...HEAD` (Track D).
- `scripts/lib/deploy-impact.mjs` — register the new `scripts/rollback-pages-deployment.mjs` path in `FULL_DEPLOY_GUARDRAIL_EXACT_PATHS` so its edits trigger the merge gate (Track B). No contract or matcher logic changes.
- `scripts/__tests__/validate-ci-parity.test.ts` — remove the `validate-node25-compat` assertion block (Track A).
- `scripts/__tests__/classify-deploy-changes.test.ts` — add a test that asserts the 3-dot command string (Track D).
- `docs/deployment-process.md` — remove validate-node25-compat line, update push-diff bullet to 3-dot, extend the pull-request-checks workflow description with gitleaks, add Pages rollback description (Tracks A+B+C+D).
- `docs/testing.md:68` — update the `github.event.before..github.sha` two-dot reference to 3-dot (Track D).

**Create:**
- `scripts/rollback-pages-deployment.mjs` — CLI helper invoking the Cloudflare Pages rollback REST endpoint (Track B).
- `scripts/__tests__/rollback-pages-deployment.test.ts` — unit test for the helper (Track B).

**Do not modify (explicit non-goals):**
- `.github/workflows/deploy-cloudflare.yml`, `.github/workflows/rebuild-pages.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/pages-prepare.yml` — Pages rollback goes inside `pages-publish.yml` so every caller inherits it with zero thread-through.
- `scripts/test-merge-gate.mjs`, `scripts/lib/validate-contract.mjs` — validate contract and merge-gate behavior are unchanged.

---

## Track A — Remove Redundant `validate-node25-compat` Job

`validate-node25-compat` runs on `node-version: 25.x` (same as `validate`) and executes a strict subset (`lint`, `typecheck`, `build`, `test:critical-contracts`). `engines.node` is `>=25 <26`, so it's a matrix leftover with no remaining value. Drop it.

### Task A1: Rewrite the parity test to cover only `validate`

**Files:**
- Modify: `scripts/__tests__/validate-ci-parity.test.ts:70-93`

- [ ] **Step 1: Replace the entire `it(...)` callback**

Using Edit, replace the `it("keeps the shared CI validate workflow aligned with the merge-gate command contract", () => { ... })` block (lines 71-93) with exactly this body:

```ts
  it("keeps the shared CI validate workflow aligned with the merge-gate command contract", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const setupWorkspaceAction = readFileSync(
      resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"),
      "utf8",
    );
    const validateJob = extractJobBlock(workflow, "validate");
    const setupWorkspaceRunSteps = extractRunSteps(setupWorkspaceAction);

    expect([...setupWorkspaceRunSteps, ...extractRunSteps(validateJob)]).toEqual([
      { cmd: "npm ci", condition: null },
      ...buildCiValidateStepPlan(),
    ]);
  });
```

The diff vs the existing test body: drops the second `expect` block (for `validate-node25-compat`), drops the `extractJobBlock(workflow, "validate-node25-compat")` call, and removes the `"validate-node25-compat"` stop-marker arg from the first `extractJobBlock` call. Keep the `describe(...)` wrapper and the file's existing imports/helpers untouched.

- [ ] **Step 2: Run the test and verify it fails against the current YAML**

Run: `npx vitest run scripts/__tests__/validate-ci-parity.test.ts`

Expected: FAIL — `extractJobBlock` without a `nextJobName` slices from `validate:` to end-of-file, so it still includes the unchanged `validate-node25-compat` job's run steps; the assertion then sees extra steps that aren't in `buildCiValidateStepPlan()`. This failure is expected and proves the test will catch drift after the job removal in Task A2.

### Task A2: Remove the `validate-node25-compat` job from the workflow

**Files:**
- Modify: `.github/workflows/validate-ci.yml:70-83`

- [ ] **Step 1: Delete the job block via a targeted Edit**

Use the Edit tool to remove the `validate-node25-compat:` job and only that job. Do not rewrite the whole file — other job steps above may have been updated by unrelated commits between plan authoring and execution.

The exact Edit:

- `old_string`:
```
      - if: ${{ inputs.worker_changed }}
        run: cd worker && npx tsc --noEmit -p tsconfig.scripts.json
  validate-node25-compat:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-workspace
        with:
          node-version: 25.x
          tooling-cache: "true"
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run build
      - run: npm run test:critical-contracts
```
- `new_string`:
```
      - if: ${{ inputs.worker_changed }}
        run: cd worker && npx tsc --noEmit -p tsconfig.scripts.json
```

After the edit, the file ends after the final worker typecheck step.

- [ ] **Step 2: Run the parity test to verify it passes**

Run: `npx vitest run scripts/__tests__/validate-ci-parity.test.ts`

Expected: PASS — the parsed workflow now contains exactly the expected steps.

### Task A3: Remove the documentation reference

**Files:**
- Modify: `docs/deployment-process.md:109`

- [ ] **Step 1: Remove the line mentioning the removed job**

Delete the bullet `   - the parallel \`validate-node25-compat\` job also runs \`npm run build\` and \`npm run test:critical-contracts\`` from the validate section. Leave the surrounding bullets intact.

- [ ] **Step 2: Verify docs still parse correctly**

Run: `npm run check:doc-counts && npm run check:verified-doc-links && npm run check:doc-source-paths`

Expected: all three pass (no stale references).

### Task A4: Verify and commit

- [ ] **Step 1: Dry-run the merge gate**

Run: `MERGE_GATE_DRY_RUN=1 npm run test:merge-gate`

Expected: plan includes the shared validate command set (prebuild + postbuild + worker). The removed job does not affect the merge-gate contract since the contract lives in `validate-contract.mjs`.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/validate-ci.yml \
        scripts/__tests__/validate-ci-parity.test.ts \
        docs/deployment-process.md
git commit -m "ci: drop redundant validate-node25-compat job"
```

---

## Track D — Align Diff Semantics to 3-Dot (Merge-Base)

`scripts/test-merge-gate.mjs` uses `git diff merge-base(origin/main, HEAD)...HEAD` (three-dot). `scripts/classify-deploy-changes.mjs` and `scripts/check-critical-coverage.mjs` both use `<base>..<head>` (two-dot). On a PR where `main` has moved since the PR was cut, 2-dot includes the "undo" of post-fork main commits; 3-dot returns only the PR's own commits. Align all three to 3-dot so CI and local agree on what changed.

**Why this is a real bug, not cosmetics:** consider main: A→B→C, PR branch: A→D. 2-dot `C..D` reports changes in C as being reverted by D (false positives → validate may run unnecessary steps or miss necessary ones). 3-dot `C...D` resolves to `merge-base(C,D)..D = A..D`, reporting only D.

### Task D1: Add a test asserting the 3-dot command shape

**Files:**
- Modify: `scripts/__tests__/classify-deploy-changes.test.ts`

- [ ] **Step 1: Append a new test to the `classifyDeployChanges` describe block**

After the existing tests, inside the `describe("classifyDeployChanges", ...)` block (before the closing brace), add:

```ts
  it("uses three-dot diff syntax so merge-base is the comparison point", () => {
    const received = [];
    const exec = (cmd) => {
      received.push(cmd);
      return "src/app/page.tsx\n";
    };

    classifyDeployChanges({
      baseSha: "aaa",
      eventName: "push",
      exec,
      headSha: "bbb",
    });

    expect(received).toEqual(["git diff --name-only aaa...bbb"]);
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run scripts/__tests__/classify-deploy-changes.test.ts`

Expected: FAIL — actual `received` is `["git diff --name-only aaa..bbb"]` (two dots), expected three dots. Confirm failure before implementing.

### Task D2: Switch `classify-deploy-changes.mjs` to 3-dot

**Files:**
- Modify: `scripts/classify-deploy-changes.mjs:51`

- [ ] **Step 1: Change the diff syntax**

Edit line 51 of `scripts/classify-deploy-changes.mjs`:

Before:
```js
    const raw = exec(`git diff --name-only ${baseSha}..${headSha}`, { encoding: "utf8" });
```

After:
```js
    const raw = exec(`git diff --name-only ${baseSha}...${headSha}`, { encoding: "utf8" });
```

- [ ] **Step 2: Update the failure message on line 58 to reflect 3-dot semantics**

Before:
```js
      reason: `Failed to diff ${baseSha}..${headSha}; falling back to full deploy path`,
```

After:
```js
      reason: `Failed to diff ${baseSha}...${headSha}; falling back to full deploy path`,
```

- [ ] **Step 3: Run the test suite for this file**

Run: `npx vitest run scripts/__tests__/classify-deploy-changes.test.ts`

Expected: all tests pass, including the new 3-dot assertion.

### Task D3: Switch `check-critical-coverage.mjs` to 3-dot

The coverage ratchet also diffs `<ref>..HEAD` (line 50). Align it to 3-dot so the ratchet sees the same changed-file set as the deploy classifier and the merge-gate.

**Files:**
- Modify: `scripts/check-critical-coverage.mjs:50`

- [ ] **Step 1: Change the diff syntax**

Edit line 50:

Before:
```js
    const raw = execSync(`git diff --name-only ${ref}..HEAD`, { encoding: "utf8" });
```

After:
```js
    const raw = execSync(`git diff --name-only ${ref}...HEAD`, { encoding: "utf8" });
```

- [ ] **Step 2: Exercise coverage locally**

Run: `npm run coverage:critical`

Expected: PASS (existing coverage state already meets baselines; syntax change is a superset at worst since 3-dot excludes "reverted" files that local 2-dot could falsely include).

### Task D4: Update the docs that still reference two-dot syntax

**Files:**
- Modify: `docs/deployment-process.md:98`
- Modify: `docs/testing.md:68`

- [ ] **Step 1: Update `docs/deployment-process.md:98`**

Line 98 today reads:
```
   - diffs `github.event.before..github.sha` on `push`
```

Edit it to:
```
   - diffs `github.event.before...github.sha` on `push` (three-dot, merge-base-resolved; identical to two-dot on push-to-main but robust if the base is ever not a strict ancestor)
```

- [ ] **Step 2: Update `docs/testing.md:68`**

Line 68 today reads:
```
   - Diffs `github.event.before..github.sha` on `push`
```

Edit it to:
```
   - Diffs `github.event.before...github.sha` on `push`
```

(Shorter phrasing than `deployment-process.md` because `testing.md` is a reference doc, not a narrative; the longer justification lives in deployment-process.md.)

- [ ] **Step 3: Grep the repo for any remaining two-dot diff references**

Use the Grep tool with pattern `\b[a-z]+\.sha\.\.[a-z]+\.sha\b` (case-insensitive, no path filter) and separately with pattern `\bbase[A-Za-z]*\.\.[hH]ead[A-Za-z]*\b`.

Expected: no hits in `docs/**`, `scripts/**`, or `.github/**` after Steps 1-2 land. If a hit appears in `agents/plans/historical/**` or `src/data/changelogs/**`, leave it — those are immutable historical artefacts.

### Task D5: Verify and commit

- [ ] **Step 1: Run merge-gate dry-run**

Run: `MERGE_GATE_DRY_RUN=1 npm run test:merge-gate`

Expected: plan unchanged (the merge gate already used 3-dot; only CI paths change).

- [ ] **Step 2: Run the full local test suite**

Run: `npm test`

Expected: all tests pass, including the new classify-deploy-changes test.

- [ ] **Step 3: Commit**

```bash
git add scripts/classify-deploy-changes.mjs \
        scripts/check-critical-coverage.mjs \
        scripts/__tests__/classify-deploy-changes.test.ts \
        docs/deployment-process.md \
        docs/testing.md
git commit -m "ci: use merge-base (three-dot) diff for deploy classification and coverage ratchet"
```

---

## Track C — Gitleaks on Pull Requests

The scheduled `secret-scan.yml` catches leaked secrets but only weekly. A secret merged Monday may live on `main` until the next Monday. Add a PR-time scan of the PR's commit range that mirrors the pinned version and integrity checks of the weekly job.

Confirmed with gitleaks v8.30.0 docs: `gitleaks git --log-opts="--all <base>..<head>" .` scans only the PR range, respects `.gitleaksignore` at the repo root, and returns non-zero on finds. GitHub Actions checkout must use `fetch-depth: 0` so the base commit is available.

### Task C1: Add the gitleaks job to the PR workflow

**Files:**
- Modify: `.github/workflows/pull-request-checks.yml`

- [ ] **Step 1: Append the new job**

After the existing `validate:` job, add a new sibling job. The final file should be:

```yaml
name: Pull Request Checks

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: pull-request-checks-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      pages_changed: ${{ steps.classify.outputs.pages_changed }}
      worker_changed: ${{ steps.classify.outputs.worker_changed }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0
      - uses: ./.github/actions/setup-workspace
        with:
          node-version: 25
          cache-npm: "false"
          install-deps: "false"
      - id: classify
        env:
          DEPLOY_BASE_SHA: ${{ github.event.pull_request.base.sha }}
          DEPLOY_EVENT_NAME: push
          DEPLOY_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: node scripts/classify-deploy-changes.mjs >> "$GITHUB_OUTPUT"

  validate:
    needs: detect-changes
    uses: ./.github/workflows/validate-ci.yml
    with:
      coverage-compare-ref: ${{ github.event.pull_request.base.sha }}
      pages_changed: ${{ needs.detect-changes.outputs.pages_changed == 'true' }}
      worker_changed: ${{ needs.detect-changes.outputs.worker_changed == 'true' }}

  gitleaks:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0

      - name: Install pinned gitleaks
        env:
          GITLEAKS_VERSION: 8.30.0
          GITLEAKS_TARBALL_SHA256: 79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e
        run: |
          curl -fsSLo /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
          echo "${GITLEAKS_TARBALL_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c -
          tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks
          chmod +x /tmp/gitleaks

      - name: Scan PR commit range for secrets
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: /tmp/gitleaks git --no-banner --redact --exit-code 1 --log-opts="--no-merges ${BASE_SHA}..${HEAD_SHA}" .
```

**Rationale for the exact values used:**
- `fetch-depth: 0` — required so `git log BASE..HEAD` resolves during the gitleaks scan (confirmed gotcha).
- `GITLEAKS_VERSION` and `GITLEAKS_TARBALL_SHA256` — identical to `secret-scan.yml` so PR and weekly scans stay version-locked. Never diverge these values.
- `--log-opts="--no-merges ${BASE_SHA}..${HEAD_SHA}"` — scans only commits in this PR, skipping merge commits; identical to the `detect-changes` diff range.
- `.gitleaksignore` is picked up automatically from the repo root — no explicit flag needed.

### Task C2: Verify the new job locally

- [ ] **Step 1: Sanity-check the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/pull-request-checks.yml'))"` (Python's PyYAML is typically present; if not, use any YAML linter).

Expected: no exception.

- [ ] **Step 2: Dry-run gitleaks locally against the current HEAD range**

Run:
```bash
(cd /tmp && curl -fsSLo gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v8.30.0/gitleaks_8.30.0_linux_x64.tar.gz" && echo "79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e  gitleaks.tar.gz" | sha256sum -c - && tar -xzf gitleaks.tar.gz)
/tmp/gitleaks git --no-banner --redact --exit-code 1 --log-opts="--no-merges origin/main..HEAD" .
```

Expected: exit code 0. Gitleaks does not emit a non-zero status when all findings match entries in `.gitleaksignore`, because suppressed matches are not counted as findings. Any non-zero exit here means a finding was detected that is NOT already ignored.

Note: this is an approximation of what CI will run. CI scans `pull_request.base.sha..head.sha`; locally you are scanning `origin/main..HEAD`. On a branch rebased onto current `origin/main`, these ranges are equivalent. On a stale branch they diverge and local may scan more (or fewer) commits than CI will. Treat this step as a smoke check, not a perfect rehearsal.

If gitleaks detects a finding that is a legitimate test fixture or documented false positive, fix the underlying code or add the finding's fingerprint to `.gitleaksignore` in the same PR that introduces it. Do not add to `.gitleaksignore` without explicit justification — the file exists for known false positives, not for silencing real leaks.

### Task C3: Document the new scan

**Files:**
- Modify: `docs/deployment-process.md:88`

- [ ] **Step 1: Extend the existing `pull-request-checks.yml` bullet in-place**

Line 88 today reads:
```
- `.github/workflows/pull-request-checks.yml` for pull-request validation on `main`
```

Replace with:
```
- `.github/workflows/pull-request-checks.yml` for pull-request validation on `main`, including a pinned gitleaks scan (`v8.30.0`, SHA256-verified) over the PR commit range (`--log-opts="--no-merges <base>..<head>"`); full-history scans still run weekly via `.github/workflows/secret-scan.yml`
```

Do not add a new bullet — extending the existing one keeps the workflow-file definition list one-entry-per-file.

- [ ] **Step 2: Verify doc sync**

Run: `npm run check:verified-doc-links && npm run check:doc-source-paths`

Expected: both pass.

### Task C4: Commit

- [ ] **Step 1: Commit**

```bash
git add .github/workflows/pull-request-checks.yml \
        docs/deployment-process.md
git commit -m "ci: add gitleaks secret scan to pull request checks"
```

---

## Track B — Pages Rollback Symmetry

`deploy-cloudflare.yml` already auto-rolls-back the Worker when post-deploy `smoke-api` fails (`wrangler rollback <previous_version_id>`). Pages has no equivalent: if `smoke-ui-live` (inside `pages-publish.yml`) fails after `deploy-pages` succeeded, the broken static export stays live.

Wrangler v4.83 exposes no Pages rollback subcommand. The Cloudflare REST API does: `POST /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/rollback` with an empty body, requiring `Pages:Edit` (already granted to `CLOUDFLARE_API_TOKEN`).

**Design:** mirror the worker path structurally. `upload-worker-version` captures `previous_version_id` as a step inside the same job that uploads the candidate; the rollback sibling job reads it via `needs.upload-worker-version.outputs.previous_version_id`. Do the same for Pages: capture `previous_deployment_id` as the first step inside `deploy-pages`, emit it as a job output, and have a sibling `rollback-pages` job read `needs.deploy-pages.outputs.previous_deployment_id`. Mark the capture step `continue-on-error: true` so a transient Cloudflare API hiccup never blocks an otherwise-green Pages deploy — the rollback gate's `previous_deployment_id != ''` guard degrades gracefully when capture fails. Place everything inside `pages-publish.yml` so every caller (`deploy-cloudflare.yml`, `rebuild-pages.yml`, `pages-release.yml`) inherits rollback with no thread-through.

### Task B1: Write a failing test for the rollback helper

**Files:**
- Create: `scripts/__tests__/rollback-pages-deployment.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, expect, it, vi } from "vitest";
import { rollbackPagesDeployment } from "../rollback-pages-deployment.mjs";

describe("rollbackPagesDeployment", () => {
  it("POSTs to the Cloudflare Pages rollback endpoint with the correct auth header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { id: "dep-1" } }), { status: 200 }),
    );

    await rollbackPagesDeployment({
      accountId: "acc-1",
      apiToken: "token-1",
      projectName: "stablecoin-dashboard",
      deploymentId: "dep-1",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-1/pages/projects/stablecoin-dashboard/deployments/dep-1/rollback",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer token-1");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it("throws when the response is a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 }),
    );

    await expect(
      rollbackPagesDeployment({
        accountId: "acc-1",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/404/);
  });

  it("throws when the response JSON indicates success=false even with a 200 status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "deployment is not eligible for rollback" }] }), { status: 200 }),
    );

    await expect(
      rollbackPagesDeployment({
        accountId: "acc-1",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/not eligible/);
  });

  it("throws when required parameters are missing", async () => {
    await expect(
      rollbackPagesDeployment({
        accountId: "",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
      }),
    ).rejects.toThrow(/accountId/);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run scripts/__tests__/rollback-pages-deployment.test.ts`

Expected: FAIL — module `../rollback-pages-deployment.mjs` does not exist.

### Task B2: Implement the rollback helper

**Files:**
- Create: `scripts/rollback-pages-deployment.mjs`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export async function rollbackPagesDeployment({
  accountId,
  apiToken,
  projectName,
  deploymentId,
  fetchImpl = fetch,
} = {}) {
  if (!accountId) throw new Error("rollbackPagesDeployment: accountId is required");
  if (!apiToken) throw new Error("rollbackPagesDeployment: apiToken is required");
  if (!projectName) throw new Error("rollbackPagesDeployment: projectName is required");
  if (!deploymentId) throw new Error("rollbackPagesDeployment: deploymentId is required");

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}/rollback`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = parsed?.errors?.map((err) => err?.message).filter(Boolean).join("; ")
      ?? text
      ?? "(no body)";
    throw new Error(`Cloudflare Pages rollback failed (HTTP ${response.status}): ${detail}`);
  }

  if (parsed && parsed.success === false) {
    const detail = parsed.errors?.map((err) => err?.message).filter(Boolean).join("; ") ?? "(no error message)";
    throw new Error(`Cloudflare Pages rollback returned success=false: ${detail}`);
  }

  return parsed?.result ?? null;
}

async function runCli() {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const projectName = (process.env.CF_PAGES_PROJECT_NAME ?? "").trim();
  const deploymentId = (process.env.CF_PAGES_DEPLOYMENT_ID ?? "").trim();

  try {
    const result = await rollbackPagesDeployment({ accountId, apiToken, projectName, deploymentId });
    console.log(`[rollback-pages] success; rolled back to deployment ${result?.id ?? deploymentId}`);
  } catch (err) {
    console.error(`[rollback-pages] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runCli();
}
```

- [ ] **Step 2: Run the test and verify it passes**

Run: `npx vitest run scripts/__tests__/rollback-pages-deployment.test.ts`

Expected: PASS — all four cases green.

- [ ] **Step 3: Smoke-test the CLI contract locally (no real API call)**

Run:
```bash
node -e "import('./scripts/rollback-pages-deployment.mjs').then(m => m.rollbackPagesDeployment({ accountId: 'a', apiToken: 't', projectName: 'p', deploymentId: 'd', fetchImpl: async () => new Response(JSON.stringify({ success: true, result: { id: 'd' } })) })).then(r => { if (r && r.id === 'd') { console.log('OK'); } else { console.error('BAD', r); process.exit(1); } })"
```

Expected: prints exactly `OK` and exits 0. The assertion is on the returned object, not on Node's object-inspection output, so formatting variance between Node patch versions does not affect correctness.

### Task B3: Classify the new script as deploy-impacting

`scripts/rollback-pages-deployment.mjs` is new infrastructure that affects the deploy path. Add it to the `FULL_DEPLOY_GUARDRAIL_EXACT_PATHS` set in `scripts/lib/deploy-impact.mjs` so changes to it trigger the merge gate and CI validate.

**Files:**
- Modify: `scripts/lib/deploy-impact.mjs:31-55`

- [ ] **Step 1: Add the new path to `FULL_DEPLOY_GUARDRAIL_EXACT_PATHS`**

Insert `"scripts/rollback-pages-deployment.mjs",` alphabetically in the `FULL_DEPLOY_GUARDRAIL_EXACT_PATHS` set (it goes between `"scripts/check-worker-migrations.mjs"` and `"scripts/smoke-api.mjs"`).

Resulting set:
```js
const FULL_DEPLOY_GUARDRAIL_EXACT_PATHS = new Set([
  "scripts/audit-pricing-provider-config.ts",
  "scripts/check-critical-coverage.mjs",
  "scripts/check-cron-connection-budget.ts",
  "scripts/check-cron-schedule-sync.ts",
  "scripts/check-doc-counts.mjs",
  "scripts/check-doc-sync.ts",
  "scripts/check-duplicate-exports.mjs",
  "scripts/check-env-contract.mjs",
  "scripts/check-hotspot-ratchet.mjs",
  "scripts/check-redemption-backstops.ts",
  "scripts/check-seo-static.mjs",
  "scripts/check-shared-cycles.mjs",
  "scripts/check-sql-interpolation-safety.mjs",
  "scripts/check-stablecoin-data.ts",
  "scripts/check-unused-code.mjs",
  "scripts/check-verified-doc-links.mjs",
  "scripts/check-worker-import-boundary.mjs",
  "scripts/check-worker-migrations.mjs",
  "scripts/rollback-pages-deployment.mjs",
  "scripts/smoke-api.mjs",
  "scripts/smoke-ops.mjs",
  "scripts/smoke-transport.mjs",
  "scripts/smoke-ui.mjs",
  "scripts/test-merge-gate.mjs",
]);
```

- [ ] **Step 2: Run the classifier tests**

Run: `npx vitest run scripts/__tests__/classify-deploy-changes.test.ts`

Expected: PASS (no assertion iterates this specific entry, but the set-membership tests still hold).

### Task B4: Inline capture into `deploy-pages` and add `rollback-pages` job

**Files:**
- Modify: `.github/workflows/pages-publish.yml`

- [ ] **Step 1: Replace the entire file contents**

The new contents:

```yaml
name: Pages Publish

on:
  workflow_call:
    inputs:
      artifact_name:
        description: Artifact name for the static export to publish.
        required: false
        default: pages-static-export
        type: string

permissions:
  contents: read

jobs:
  deploy-pages:
    runs-on: ubuntu-latest
    outputs:
      previous_deployment_id: ${{ steps.capture.outputs.deployment_id }}
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-workspace
        with:
          node-version: 25
      - id: capture
        name: Capture current production Pages deployment id (best effort)
        continue-on-error: true
        run: |
          cd worker
          npx --no-install wrangler pages deployment list --project-name=stablecoin-dashboard --environment=production --json > /tmp/wrangler-pages-deployments.json
          node <<'NODE' >> "$GITHUB_OUTPUT"
          const fs = require("node:fs");
          const entries = JSON.parse(fs.readFileSync("/tmp/wrangler-pages-deployments.json", "utf8"));
          const current = Array.isArray(entries) && entries.length > 0 ? entries[0] : null;
          const id = current && typeof current.Id === "string" ? current.Id : "";
          process.stdout.write(`deployment_id=${id}\n`);
          NODE
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: ${{ inputs.artifact_name }}
          path: out
      - name: Deploy Pages with retry
        run: |
          for attempt in 1 2 3; do
            echo "[deploy-pages] Attempt ${attempt}/3"
            if npx --no-install wrangler pages deploy out --project-name=stablecoin-dashboard --commit-dirty=true --commit-message="${{ github.sha }}"; then
              exit 0
            fi
            if [ "$attempt" -eq 3 ]; then
              echo "[deploy-pages] Exhausted retries"
              exit 1
            fi
            sleep $((attempt * 15))
          done

  smoke-ui-live:
    needs: deploy-pages
    runs-on: ubuntu-latest
    env:
      SMOKE_UI_EXPECT_GA_ID: ${{ vars.NEXT_PUBLIC_GA_ID }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-workspace
        with:
          node-version: 25
          cache-npm: "false"
          install-deps: "false"
      - run: npm run test:smoke-ui -- --url https://pharos.watch --mode live

  rollback-pages:
    needs:
      - deploy-pages
      - smoke-ui-live
    if: >-
      ${{
        always()
        && needs.deploy-pages.result == 'success'
        && needs.smoke-ui-live.result == 'failure'
        && needs.deploy-pages.outputs.previous_deployment_id != ''
      }}
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      CF_PAGES_PROJECT_NAME: stablecoin-dashboard
      CF_PAGES_DEPLOYMENT_ID: ${{ needs.deploy-pages.outputs.previous_deployment_id }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-workspace
        with:
          node-version: 25
      - name: Roll back Pages production to previous successful deployment
        run: node scripts/rollback-pages-deployment.mjs
```

**Rationale for exact structure:**
- **Capture is a step inside `deploy-pages`, mirroring `upload-worker-version` in `deploy-cloudflare.yml:71-82`.** Both jobs capture the "previous production ID" immediately before pushing a new version, in the same job that performs the push.
- **`continue-on-error: true` on the capture step** means a transient Cloudflare API hiccup does not block an otherwise-green Pages deploy. The step's `$GITHUB_OUTPUT` will be unset in that case, which naturally sets `deployment_id` to the empty string — the rollback gate's `previous_deployment_id != ''` check then disables rollback. Net effect: a partial availability loss on rollback, not on deploy. Aligns with the reviewer's concern that adding capture must not introduce a new deploy-blocking failure mode.
- **Capture runs BEFORE `actions/download-artifact` and `wrangler pages deploy`** so `entries[0]` is always the pre-existing production deployment, never our new one.
- **`deploy-pages.outputs.previous_deployment_id`** exposes the step output at the job level so `rollback-pages` can read it via `needs.deploy-pages.outputs.previous_deployment_id`.
- **`smoke-ui-live`** is behaviorally unchanged from the previous file.
- **`rollback-pages` gate uses `always()`** because a `failure` on `smoke-ui-live` would otherwise mark `rollback-pages` as skipped by default. The three post-`always` conditions together encode: deploy succeeded, smoke failed, and we have a target ID.
- **`CF_PAGES_PROJECT_NAME: stablecoin-dashboard`** matches the `--project-name` arg used in both capture and deploy for consistency.

### Task B5: Validate the workflow parses and job graph is correct

- [ ] **Step 1: Lint the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pages-publish.yml'))"`

Expected: no exception.

- [ ] **Step 2: Spot-check the `actionlint` output if available**

If `actionlint` is installed:
```bash
actionlint .github/workflows/pages-publish.yml
```

Expected: no errors. If `actionlint` is not installed, skip this step — GitHub's own workflow parser will run on push.

- [ ] **Step 3: Verify the `deploy-cloudflare.yml` gates still align**

Open `.github/workflows/deploy-cloudflare.yml` and confirm:
- `pages-publish` is still called via `uses: ./.github/workflows/pages-publish.yml` and does not pass inputs that were removed (there are none to remove).
- `smoke-ops` and `smoke-transport` jobs downstream already condition on `needs.pages-publish.result == 'success'` — a failed `smoke-ui-live` inside pages-publish propagates as `failure` and naturally blocks ops/transport smokes. No change needed.

No edits to `deploy-cloudflare.yml`. Record this in the commit message.

### Task B6: Document the Pages rollback step

**Files:**
- Modify: `docs/deployment-process.md`

- [ ] **Step 1: Extend the `pages-publish` description with capture + rollback**

Find the `pages-publish` bullet in the deploy sequence (around lines 136-143) that begins `executes the publish Pages path`. Replace that nested bullet list with:

```markdown
   - executes the publish Pages path:
     - `deploy-pages` first captures the current Cloudflare Pages production deployment id (via `wrangler pages deployment list --project-name=stablecoin-dashboard --environment=production --json`) as a best-effort step (continue-on-error), emits it as the `previous_deployment_id` job output, then publishes the already verified artifact through Wrangler with the existing retry loop
     - `smoke-ui-live` then runs `npm run test:smoke-ui -- --url https://pharos.watch --mode live` against the real public host, including the same homepage shell/static-payload GA snippet check when configured
     - `rollback-pages` calls the Cloudflare Pages rollback REST API via `scripts/rollback-pages-deployment.mjs` when `deploy-pages` succeeded but `smoke-ui-live` failed and `previous_deployment_id` is non-empty, restoring the previously live Pages production deployment; the overall workflow still surfaces as failed so the incident is visible
```

Leave all other bullets in `deployment-process.md` unchanged.

- [ ] **Step 2: Verify doc sync**

Run: `npm run check:verified-doc-links && npm run check:doc-source-paths && npm run check:doc-sync`

Expected: all three pass.

### Task B7: Full verification and commit

- [ ] **Step 1: Run the merge gate in dry-run**

Run: `MERGE_GATE_DRY_RUN=1 npm run test:merge-gate`

Expected: the plan includes both build+seo and worker-typecheck sets (because we touched shared/deploy-infra paths via `scripts/lib/deploy-impact.mjs` and added new infra scripts).

- [ ] **Step 2: Run the full local merge gate**

Run: `npm run test:merge-gate`

Expected: all commands pass, including the new rollback-pages test.

- [ ] **Step 3: Commit**

```bash
git add scripts/rollback-pages-deployment.mjs \
        scripts/__tests__/rollback-pages-deployment.test.ts \
        scripts/lib/deploy-impact.mjs \
        .github/workflows/pages-publish.yml \
        docs/deployment-process.md
git commit -m "ci: add Pages rollback on post-deploy smoke failure"
```

---

## Final Verification

After all four commits land, run a final merge-gate pass and manual smoke checks.

- [ ] **Step 1: Re-run the merge gate**

Run: `npm run test:merge-gate`

Expected: full validate path runs (the commits touched Pages + Worker deploy infra paths), all commands pass.

- [ ] **Step 2: Verify the four workflows parse**

Run:
```bash
for f in .github/workflows/validate-ci.yml .github/workflows/pages-publish.yml .github/workflows/pull-request-checks.yml .github/workflows/deploy-cloudflare.yml; do
  python3 -c "import yaml; yaml.safe_load(open('${f}'))" && echo "OK ${f}"
done
```

Expected: four `OK ...` lines.

- [ ] **Step 3: Manually trace the deploy graph once more**

Read `.github/workflows/deploy-cloudflare.yml` and `.github/workflows/pages-publish.yml` in sequence. Confirm:
- `detect-changes → validate → upload-worker-version → pages-prepare → pages-publish`
- Inside `pages-publish`: `deploy-pages` (with inline capture step) `→ smoke-ui-live → (on failure) rollback-pages`
- `smoke-ops` and `smoke-transport` are downstream of `pages-publish.result == 'success'` — on smoke failure + rollback, they remain correctly gated out.

- [ ] **Step 4: Push only after all four commits are green locally**

```bash
git log --oneline origin/main..HEAD
```

Expected: four commits in order: `ci: drop redundant validate-node25-compat job`, `ci: use merge-base (three-dot) diff ...`, `ci: add gitleaks secret scan to pull request checks`, `ci: add Pages rollback on post-deploy smoke failure`.

Do not squash — each commit is independently revertable.

```bash
git push origin main
```

---

## Rollback Plan

If any of the four tracks regress in CI after push:

- **A regression** (parity test fails): `git revert <A-sha>` restores the old job and test. No data or deploy impact.
- **D regression** (CI classification misfires): `git revert <D-sha>` returns to 2-dot diff. Watch the next few deploys for false-positive pages/worker typechecks.
- **C regression** (gitleaks false positive on a legitimate PR change): add the specific fingerprint to `.gitleaksignore` in a follow-up commit rather than reverting — the scan catches real problems too.
- **B regression** (Pages rollback misfires or fails):
  - If the inline `capture` step fails (e.g., wrangler API outage), `continue-on-error: true` lets deploy proceed; `previous_deployment_id` is empty and the `rollback-pages` gate blocks. No production impact, but rollback is temporarily unavailable for this deploy.
  - If `rollback-pages` itself errors (e.g., Cloudflare returns 500), the workflow remains failed; operator investigates via dashboard. Manual rollback via the Cloudflare Pages dashboard is always available.
  - To disable rollback entirely while keeping capture: change the `if:` condition in `rollback-pages` to `false`. Safer than reverting the whole commit.
