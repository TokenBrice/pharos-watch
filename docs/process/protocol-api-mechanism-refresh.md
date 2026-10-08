# Protocol API Mechanism Refresh

The [Protocol API Mechanism Refresh](../../.github/workflows/protocol-api-mechanism-refresh.yml) captures first-party mechanism evidence for `usde-ethena` and `usdf-falcon`. Manual collection and reviewed weekly automation are permanent non-publishing evidence tooling (operator decision 2026-10-08), not a shadow score engine. Collection cannot update a Safety Score overlay, fact set, evaluation identity, or score; useful economic facts still require human-reviewed curation.

## Artifact Contract

The producer writes append-only Artifact V2 files under `shared/data/safety-score-v9/mechanism-measurements/<assetId>/`. Each artifact preserves the exact response bytes, selected response headers, source observation times, strict normalized payloads, metric derivations, and blockers.

The one frozen USDe V1 artifact predates the raw-byte contract and remains immutable. Strict replay verifies its original normalized bytes against the exact SHA-256 and designated path, while explicitly reporting raw-source replay unavailable. A matching Git summary is metadata recognition only, not proof that original bytes were read or preserved. Every subsequent Artifact V2 file in the two target directories must pass raw-byte replay. Other mechanism evidence in the broader root belongs to its producer. No new V1 captures are admitted; the legacy exception has no score authority.

Observation hashes bind the source ID, URL, observation time, and raw-body hash. Selected response headers are preserved as first-capture transport metadata but do not enter the observation hash. The artifact `snapshotId` binds the ordered observation hashes to the schema, family, and asset. Capture time is excluded from that identity, so retrying an unchanged snapshot is an idempotent no-op. A conflicting snapshot or an attempt to replace existing evidence fails closed.

Numeric source values and derived ratios use canonical decimal strings and fixed-point arithmetic. Metrics distinguish `measured`, `documented-only`, `unavailable`, and `not-applicable`; qualitative claims never become quantitative ratios. Offline replay starts from the recorded raw bytes, verifies their hashes, reparses the source schemas, recomputes every derivation and identity, and requires byte-identical canonical output. Latest selection compares the full target-ordered vector of source observation times; two different snapshots with the same vector are ambiguous and fail closed.

Archive resolution uses original local bytes or a hash-checked local cache first. When neither exists, it performs signed R2 GETs against `pinned/` then `captures/`, verifies the original-body hash and writes verified bytes to the local cache. Replay is network-free only when those original bytes are already available locally. Missing account/access, expired or missing objects, unreadable or corrupt bodies remain unavailable evidence. Both `--replay` and `--replay-all` fail on unavailable evidence, report verified V2 / hash-verified normalized-only V1 / unavailable counts separately, and never count unavailable V2 as the V1 exception. A preservation claim requires actual original-byte hash readback.

Live capture consumes each response body once, then requires a successful HTTP response, a JSON media type, and an object- or array-shaped body before schema parsing. Every response emits bounded transport provenance: source ID, query-free configured and final URLs, status, redirect state, normalized media type, byte length, body SHA-256, a coarse body class, and selected length-bounded edge headers. Response bytes, decoded text, query strings, cookies, authorization material, and arbitrary headers are never logged. Edge diagnostics remain capture logs only and do not enter Artifact V2 transport headers or evidence identity.

## Target Semantics

### Ethena USDe

USDe combines Ethena's collateralization-status and proof-of-reserves observations. Collateralization observations may be at most 12 hours old, PoR observations at most 10 days old, and timestamps may not be more than 5 minutes in the future.

The producer measures collateralization, reserve excess, and the dedicated Reserve Fund share. Delta-neutral and overcollateralized statements remain dated qualitative claims. Quantitative hedge coverage, exchange-margin headroom, funding-basis stress, and executable unwind capacity remain unavailable. Direct score adoption stays blocked; measured collateral/fund facts can inform confirmatory or adverse human curation, never substitute excess collateral for exchange margin or custody allocation for hedge notional.

### Falcon USDf

USDf uses `https://api.falcon.finance/api/v1/transparency`, with a maximum source age of 36 hours and the common 5-minute future tolerance. Asset-allocation cells may arrive as quoted decimals or exact JSON number tokens; both forms normalize to nonnegative canonical decimal strings without `Number` coercion. The asset rows must reconcile to top-level TVL within `max($0.01, TVL * 1e-9)` using exact decimal arithmetic.

The separately published `reserves` total has unresolved scope, is never admitted as backing, and is reported only as the `publishedReservesToAssetRows` and `publishedReservesToSupply` reconciliations for scope diagnosis. The insurance fund is measured separately as dedicated loss absorption and is not added to collateral TVL. An empty `venues` object means venue evidence was not published; it does not establish zero exposure. Hedge coverage, exchange-margin headroom, funding stress, and executable unwind capacity remain unavailable, so direct score adoption is blocked.

## Automation

The weekly workflow runs an explicit matrix over `usde-ethena` and `usdf-falcon` with one branch per target:

- `automated/protocol-api-mechanism-refresh/usde-ethena`
- `automated/protocol-api-mechanism-refresh/usdf-falcon`

The workflow captures and replays evidence from the trusted default checkout. It inspects the target branch and PR history before capture, but it does not check out an existing automation branch until after the focused producer test, repository-wide replay, and local additions-only artifact validation pass. This keeps repository-local actions, npm lifecycle behavior, and producer scripts sourced from `main` rather than from an unreviewed refresh PR branch.

Only the trusted capture and strict archive-replay steps receive `CLOUDFLARE_ACCOUNT_ID`, `R2_MEASUREMENTS_ACCESS_KEY_ID`, and `R2_MEASUREMENTS_SECRET_ACCESS_KEY`. No R2 credential is job-wide, supplied to tests or present in the branch-checkout/PR-write step. The existing archive credentials must permit original-byte GET readback; absent secrets or unreadable objects stop the workflow rather than creating a green summary-only replay. Secret provisioning and actual R2 preservation/readback remain operator operations, not inferred from these environment bindings.

If a target already has an open refresh PR and a new artifact was produced, the token-gated update step copies the validated artifact aside, points `core.hooksPath` at an empty temporary directory, snapshots `scripts/ci/verify-mechanism-refresh-diff.ts` and its imports into the temporary directory, checks out that branch, rebases it onto `origin/main`, revalidates the pre-existing PR diff as append-only target artifacts, restores the new artifact, and commits it. Disabling repository hooks before the unreviewed branch checkout prevents branch-controlled hook code from executing while the refresh token is available, and every verification after the checkout runs from the snapshot's absolute path so no verifier code is loaded from the unreviewed branch while the token is present. This preserves unmerged append-only history. With no open PR, the workflow inspects the remote branch and PR history before starting from `origin/main`; closed-unmerged, orphaned, or otherwise ambiguous branch state fails for operator review.

Jobs use target-specific concurrency, stage only the target's evidence directory, run focused tests and repository-wide replay, and require the PR diff to contain additions only under that directory. They open or update a non-auto-merge PR only after those checks pass.

The PR records the snapshot identity, measured and unavailable metrics, adoption blockers, and the expected confirmatory or indeterminate effect. Automation never edits an overlay or grants an artifact score authority.

The November 4 operations packet remains an observability/cost inventory, not a sunset decision: record actual scheduled/manual attempts and failures, changed snapshots versus idempotent no-ops, real PR/branch outcomes, reviewer and privileged-write maintenance cost, original-byte R2 readback, and economic facts used/deferred in curation. Committed snapshot counts and a denied status read are not execution or inactivity evidence. Retention of automation does not admit a source into scoring.

## Manual Use

Live capture requires an explicit allowlisted target:

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
