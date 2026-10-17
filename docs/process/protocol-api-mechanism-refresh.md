# Protocol API Mechanism Refresh

The protocol API producer captures first-party mechanism evidence for `usde-ethena` and `usdf-falcon`. The [Protocol API Mechanism Refresh workflow](../../.github/workflows/protocol-api-mechanism-refresh.yml) refreshes Falcon automatically; Ethena is refreshed manually from a permitted region. Manual collection and reviewed weekly automation are permanent non-publishing evidence tooling (operator decision 2026-10-08), not a shadow score engine. Collection cannot update a Safety Score overlay, fact set, evaluation identity, or score; useful economic facts still require human-reviewed curation.

## Artifact Contract

The producer writes append-only Artifact V2 files under `shared/data/safety-score-v9/mechanism-measurements/<assetId>/`. Each artifact preserves the exact response bytes, selected response headers, source observation times, strict normalized payloads, metric derivations, and blockers.

The one frozen USDe V1 artifact predates the raw-byte contract and remains immutable. Strict replay verifies its original normalized bytes against the exact SHA-256 and designated path, while explicitly reporting raw-source replay unavailable. A matching Git summary is metadata recognition only, not proof that original bytes were read or preserved. Every subsequent Artifact V2 file in the two target directories must pass raw-byte replay. Other mechanism evidence in the broader root belongs to its producer. No new V1 captures are admitted; the legacy exception has no score authority.

Observation hashes bind the source ID, URL, observation time, and raw-body hash. Selected response headers are preserved as first-capture transport metadata but do not enter the observation hash. The artifact `snapshotId` binds the ordered observation hashes to the schema, family, and asset. Capture time is excluded from that identity, so retrying an unchanged snapshot is an idempotent no-op. A conflicting snapshot or an attempt to replace existing evidence fails closed.

Numeric source values and derived ratios use canonical decimal strings and fixed-point arithmetic. Metrics distinguish `measured`, `documented-only`, `unavailable`, and `not-applicable`; qualitative claims never become quantitative ratios. Offline replay starts from the recorded raw bytes, verifies their hashes, reparses the source schemas, recomputes every derivation and identity, and requires byte-identical canonical output. Latest selection compares the full target-ordered vector of source observation times; two different snapshots with the same vector are ambiguous and fail closed.

Archive resolution uses original local bytes or a hash-checked local cache first. When neither exists, it performs signed R2 GETs against `pinned/` then `captures/`, verifies the original-body hash and writes verified bytes to the local cache. Replay is network-free only when those original bytes are already available locally. Missing account/access, expired or missing objects, unreadable or corrupt bodies remain unavailable evidence. Both `--replay` and `--replay-all` fail on unavailable evidence, report verified V2 / hash-verified normalized-only V1 / unavailable counts separately, and never count unavailable V2 as the V1 exception. A preservation claim requires actual original-byte hash readback.

Live capture consumes each response body once, then requires a successful HTTP response, a JSON media type, and an object- or array-shaped body before schema parsing. Every response emits bounded transport provenance: source ID, query-free configured and final URLs, status, redirect state, normalized media type, byte length, body SHA-256, a coarse body class, and selected length-bounded edge headers. Response bytes, decoded text, query strings, cookies, authorization material, and arbitrary headers are never logged. Edge diagnostics remain capture logs only and do not enter Artifact V2 transport headers or evidence identity.

Transport diagnostics also carry a machine-readable `reason`: `http-error` for unsuccessful HTTP status, `non-json-media-type` for missing or non-JSON media type, `unexpected-body-class` for a body that is neither object- nor array-shaped, or `null` when the transport gate accepts the response. HTTP status takes precedence over media type, which takes precedence over body shape. A redirect to restricted HTML remains a failed capture even when the final status is 200; schema and freshness validation still run only after transport acceptance.

## Target Semantics

### Ethena USDe

USDe combines Ethena's collateralization-status and proof-of-reserves observations. Collateralization observations may be at most 12 hours old, PoR observations at most 10 days old, and timestamps may not be more than 5 minutes in the future. The collateralization timestamp accepts the current ISO UTC form (`YYYY-MM-DDTHH:mm:ss[.fraction]Z`, observed with six fractional digits on October 16) and the legacy `YYYY-MM-DD HH:mm:ss[.fraction] UTC` form needed to replay retained captures. Both normalize by truncating sub-millisecond precision, reject invalid calendar dates, and retain the same freshness limits.

The producer measures collateralization, reserve excess, and the dedicated Reserve Fund share. Delta-neutral and overcollateralized statements remain dated qualitative claims. Quantitative hedge coverage, exchange-margin headroom, funding-basis stress, and executable unwind capacity remain unavailable. Direct score adoption stays blocked; measured collateral/fund facts can inform confirmatory or adverse human curation, never substitute excess collateral for exchange margin or custody allocation for hedge notional.

#### Restricted-access source investigation

The [September 30](https://github.com/TokenBrice/pharos-watch/actions/runs/36702589056) and [October 7](https://github.com/TokenBrice/pharos-watch/actions/runs/37611433702) captures followed `https://app.ethena.fi/api/collateralization/status` to `https://ethena.fi/restricted`: HTTP 200, `text/html`, and an HTML-shaped body. The restricted page states that access may depend on country or wallet risk; its text is not collateralization evidence.

The October 8 investigation found no supported replacement with an equivalent, documented backing/fund/supply contract:

- Ethena's [backing-assets documentation](https://docs.ethena.fi/backing-assets/overview) points to the official [Transparency dashboard](https://app.ethena.fi/dashboards/transparency). Its rendered page still requests the configured collateralization-status and `/api/por` endpoints. Local GET probes returned JSON without redirects for both; that egress-specific observation does not establish access from scheduled GitHub runners or resolve the recorded failures.
- The documented [public API](https://docs.ethena.fi/api-documentation/overview) is a whitelisted mint/redeem API, not a public reserves interface.
- The [PoR engineering description](https://ethena.fi/blog/ethena-engineering-blog-proof-of-reserves) documents an enclave-generated JSON proof and weekly attestation process, but does not provide a replacement public retrieval endpoint or a documented reserves-oracle address.
- The [real-time dashboard documentation](https://docs.ethena.fi/backing-custody-and-security/real-time-dashboards) explicitly warns that Copper/Ceffu deposit addresses do not represent the protocol's full backing. Token supply or those address balances cannot substitute for total backing and the separate Reserve Fund.

The source cutover remains blocked pending an official retrieval/access contract covering these fields. Keep the existing source configuration and fail-closed validation; do not invent a URL, bypass provider restrictions, infer complete backing from partial on-chain balances, or add blind retries. The focused transport fixture covers restricted HTML with both its real media type and a misleading JSON media type.

The [October 14 run](https://github.com/TokenBrice/pharos-watch/actions/runs/38542679338) retained the same restricted-HTML failure. On October 16, local capture received JSON from both configured endpoints without redirects and exposed a separate schema-format drift: collateralization `timestamp` was `2026-10-16T09:00:00.000000Z` instead of the legacy UTC format. Supporting that ISO UTC format restored live capture and deterministic raw-byte replay locally. It does not establish access from the scheduled runner or clear the provider-access prerequisite.

### Falcon USDf

USDf uses `https://api.falcon.finance/api/v1/transparency`, with a maximum source age of 36 hours and the common 5-minute future tolerance. Asset-allocation cells may arrive as quoted decimals or exact JSON number tokens; both forms normalize to nonnegative canonical decimal strings without `Number` coercion. The asset rows must reconcile to top-level TVL within `max($0.01, TVL * 1e-9)` using exact decimal arithmetic.

The separately published `reserves` total has unresolved scope, is never admitted as backing, and is reported only as the `publishedReservesToAssetRows` and `publishedReservesToSupply` reconciliations for scope diagnosis. The insurance fund is measured separately as dedicated loss absorption and is not added to collateral TVL. An empty `venues` object means venue evidence was not published; it does not establish zero exposure. Hedge coverage, exchange-margin headroom, funding stress, and executable unwind capacity remain unavailable, so direct score adoption is blocked.

## Automation

The hosted workflow's matrix is authored directly in its YAML and runs only `usdf-falcon`, using `automated/protocol-api-mechanism-refresh/usdf-falcon`. Both scheduled runs and manual workflow dispatches use that same matrix. `usde-ethena` was removed from hosted collection on October 16 because the October 14 GitHub-hosted capture was redirected to `ethena.fi/restricted` by Ethena's US geo-restriction. The asset, reserve adapter, producer target, retained evidence, and strict replay remain supported; its live capture follows [Manual Use](#manual-use) from a permitted region instead.

The refresh job admits scheduled and manual runs only on `refs/heads/main`; non-main manual dispatches are skipped before checkout or credentials. The workflow captures and replays evidence from that trusted checkout. It inspects the target branch and PR history before capture, deleting only a confirmed merged target branch when squash-merge history requires cleanup. It does not check out an existing automation branch until after the focused producer test, repository-wide replay, and local additions-only artifact validation pass. This keeps repository-local actions, npm lifecycle behavior, and producer scripts sourced from `main` rather than from an unreviewed refresh PR branch.

Only the trusted capture and strict archive-replay steps receive `CLOUDFLARE_ACCOUNT_ID`, `R2_MEASUREMENTS_ACCESS_KEY_ID`, and `R2_MEASUREMENTS_SECRET_ACCESS_KEY`. No R2 credential is job-wide, supplied to tests or present in the branch-checkout/PR-write step. The existing archive credentials must permit original-byte GET readback; absent secrets or unreadable objects stop the workflow rather than creating a green summary-only replay. Secret provisioning and actual R2 preservation/readback remain operator operations, not inferred from these environment bindings.

If a target already has an open refresh PR and capture produced an artifact absent from `main`, the token-gated update step **moves** the validated artifact aside before checkout, rather than leaving an untracked file that could collide with an artifact already committed in the PR. It bundles `scripts/ci/verify-mechanism-refresh-diff.ts` with its complete import closure from trusted `main` into the temporary directory. It explicitly fetches the existing branch, checks it out, rebases it onto `origin/main`, and revalidates the pre-existing PR diff as append-only target artifacts. All subsequent verification and artifact restoration use that absolute trusted bundle; no verifier or protocol helper is loaded from the unreviewed branch while the automation token is present. With no open PR, the workflow inspects branch ownership before starting from `origin/main`; closed-unmerged, orphaned, or otherwise ambiguous branch state fails for operator review.

Restoration replays both incoming and any existing same-path V2 artifact, then uses the producer's source-snapshot equality contract. Matching snapshots retain the PR's immutable first-capture bytes (capture time and transport metadata may legitimately differ); different source content or derivation fails without overwriting retained evidence. New paths are restored and staged, then only genuine additions are committed. If capture is already recorded on `main`, the PR step is skipped. If capture is already recorded only in the open PR, the update step exits successfully with “No new … protocol API snapshot beyond the existing refresh PR,” without a commit, push, or PR edit.

The [October 17 post-fix dispatch](https://github.com/TokenBrice/pharos-watch/actions/runs/39038602301) failed at checkout, not branch ownership: its `13:57:05Z` capture produced `2026-10-16T11-03-02.000Z-7f8f972a9f55-protocol-api.json`, and `13:57:09Z` still reported that file as untracked. [Open PR #1464](https://github.com/TokenBrice/pharos-watch/pull/1464) already contained the same path, so copying it aside without removing it left a checkout collision. The runner had fetched the automation branch with full history; merged-branch tracking-ref cleanup was not the failing path. The handoff regression test executes the workflow's real checkout, rebase, trusted bundle, restoration, and green no-change exit against a local Git fixture, including an initially absent tracking ref.

Jobs use target-specific concurrency, stage only the target's evidence directory, run focused tests and repository-wide replay, and require the PR diff to contain additions only under that directory. They open or update a non-auto-merge PR only after those checks pass.

With no open PR and no closed-unmerged history, a branch whose tip is already an ancestor of `origin/main` can restart from current `main`. A squash merge can leave the branch tip unreachable from `main`; in that case the trusted verifier queries merged PRs targeting `main` with the exact automation branch as their head and requires a merged PR's `headRefOid` to match the current branch tip. It then deletes only `automated/protocol-api-mechanism-refresh/<assetId>`, clears that branch's local remote-tracking ref so the next force-with-lease push expects an absent remote branch, and prepares the next refresh from `origin/main`, never replaying the stale merged branch. Branch preparation also clears a stale tracking ref when the remote branch is already absent. Both branch-validation and branch-preparation stages enforce this lifecycle. An older merged PR does not authorize deleting later unreviewed commits. Multiple open PRs, an open PR with no remote branch, closed-unmerged history without an open PR, and unowned commits without a matching merged PR still fail for operator review; lookup or cleanup failures stop the run. The main-only refresh job grants its step-scoped `github.token` `contents: write` for branch deletion and `pull-requests: read` for ownership checks; the separate automation token remains required to publish a normally checked PR. Manual branch validation likewise needs an authenticated `gh` token with those permissions if cleanup is required. No repository-wide auto-delete setting is changed.

The PR records the snapshot identity, measured and unavailable metrics, adoption blockers, and the expected confirmatory or indeterminate effect. Automation never edits an overlay or grants an artifact score authority.

The November 4 operations packet remains an observability/cost inventory, not a sunset decision: record actual scheduled/manual attempts and failures, changed snapshots versus idempotent no-ops, real PR/branch outcomes, reviewer and privileged-write maintenance cost, original-byte R2 readback, and economic facts used/deferred in curation. Committed snapshot counts and a denied status read are not execution or inactivity evidence. Retention of automation does not admit a source into scoring.

## Manual Use

Live capture requires an explicit allowlisted target. Refresh Ethena manually from a provider-permitted region; GitHub workflow dispatch does not run the Ethena capture:

```bash
npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --asset usde-ethena
npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --asset usdf-falcon
```

Replay one artifact or validate all committed and newly captured artifacts:

```bash
npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --replay <artifact.json>
npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --replay-all
```

Live options, explicit replay paths, and `--replay-all` are mutually exclusive. Unknown or duplicate targets fail before network or filesystem work.

### Accepting a manual Ethena refresh

Use the same evidence acceptance and reviewed PR procedure as hosted collection:

1. Start from trusted current `main` and inspect the target refresh branch/history with `GITHUB_REPOSITORY=TokenBrice/pharos-watch node --import tsx scripts/ci/verify-mechanism-refresh-diff.ts --asset usde-ethena --stage validate-branch`. Resolve any ownership refusal explicitly; never overwrite unowned history.
2. From a permitted region, run `npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --asset usde-ethena`. The default output directory is the reviewed evidence root; `--out-dir <path>` is available for an exploratory capture but does not include that directory in `--replay-all`. Both configured endpoints must pass transport, schema, freshness, and deterministic derivation checks without bypassing provider restrictions.
3. Run `npx vitest run scripts/__tests__/measure-protocol-api-mechanism-metrics.test.ts`, replay the exact new artifact with `--replay <artifact.json>`, and run `--replay-all` against the evidence root. Supply the documented archive credentials when original bytes require signed R2 reads. Unavailable or corrupt evidence blocks acceptance.
4. Review the local diff for new target `*-protocol-api.json` artifacts only; existing artifacts, summaries, overlays, and score identities must remain unchanged. An identical source snapshot is a no-op, not a reason to rewrite retained evidence.
5. Use the branch ownership and append-only PR process under [Automation](#automation). On the prepared refresh branch, commit only accepted new target artifacts and run `node --import tsx scripts/ci/verify-mechanism-refresh-diff.ts --asset usde-ethena --stage verify-diff` against `origin/main` before submission. Open or update a normally checked, human-reviewed, non-auto-merge PR that records snapshot identity, measured/unavailable metrics, adoption blockers, and expected effect. Normal pre-push readiness still applies; passing producer checks grants no direct score authority.
