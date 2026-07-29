# Protocol API Mechanism Refresh

The [Protocol API Mechanism Refresh](../../.github/workflows/protocol-api-mechanism-refresh.yml) captures first-party mechanism evidence for `usde-ethena` and `usdf-falcon`. The evidence is producer-only: collection cannot update a Safety Score overlay, fact set, evaluation identity, or score.

## Artifact Contract

The producer writes append-only Artifact V2 files under `shared/data/safety-score-v9/mechanism-measurements/<assetId>/`. Each artifact preserves the exact response bytes, selected response headers, source observation times, strict normalized payloads, metric derivations, and blockers.

The one committed USDe V1 artifact predates the raw-byte contract and remains immutable. Refresh-target validation pins its exact SHA-256 as frozen normalized-only evidence, reports that raw replay is unavailable, and validates every subsequent Artifact V2 file under the `usde-ethena` and `usdf-falcon` target directories through raw-byte replay. Other mechanism evidence may share the broader `mechanism-measurements/` root and is owned by its producer, not by this refresh. The legacy artifact has no score authority and must not be used as a template for new captures.

Observation hashes bind the source ID, URL, observation time, and raw-body hash. Selected response headers are preserved as first-capture transport metadata but do not enter the observation hash. The artifact `snapshotId` binds the ordered observation hashes to the schema, family, and asset. Capture time is excluded from that identity, so retrying an unchanged snapshot is an idempotent no-op. A conflicting snapshot or an attempt to replace existing evidence fails closed.

Numeric source values and derived ratios use canonical decimal strings and fixed-point arithmetic. Metrics distinguish `measured`, `documented-only`, `unavailable`, and `not-applicable`; qualitative claims never become quantitative ratios. Offline replay starts from the recorded raw bytes, verifies their hashes, reparses the source schemas, recomputes every derivation and identity, and requires byte-identical canonical output. Latest selection compares the full target-ordered vector of source observation times; two different snapshots with the same vector are ambiguous and fail closed.

## Target Semantics

### Ethena USDe

USDe combines Ethena's collateralization-status and proof-of-reserves observations. Collateralization observations may be at most 12 hours old, PoR observations at most 10 days old, and timestamps may not be more than 5 minutes in the future.

The producer measures collateralization, reserve excess, and the dedicated Reserve Fund share. Delta-neutral and overcollateralized statements remain dated qualitative claims. Quantitative hedge coverage, exchange-margin headroom, funding-basis stress, and executable unwind capacity remain unavailable. The resulting artifact is adoption-blocked and is expected to confirm the restrictive disposition rather than clear it.

### Falcon USDf

USDf uses `https://api.falcon.finance/api/v1/transparency`, with a maximum source age of 36 hours and the common 5-minute future tolerance. Asset-allocation cells may arrive as quoted decimals or exact JSON number tokens; both forms normalize to nonnegative canonical decimal strings without `Number` coercion. The asset rows must reconcile to top-level TVL within `max($0.01, TVL * 1e-9)` using exact decimal arithmetic.

The separately published `reserves` total has unresolved scope and is excluded from backing while it does not reconcile with asset TVL. The insurance fund is measured separately as dedicated loss absorption and is not added to collateral TVL. An empty `venues` object means venue evidence was not published; it does not establish zero exposure. Hedge coverage, exchange-margin headroom, funding stress, and executable unwind capacity remain unavailable, so direct score adoption is blocked.

## Automation

The weekly workflow runs an explicit matrix over `usde-ethena` and `usdf-falcon` with one branch per target:

- `automated/protocol-api-mechanism-refresh/usde-ethena`
- `automated/protocol-api-mechanism-refresh/usdf-falcon`

The workflow captures and replays evidence from the trusted default checkout. It inspects the target branch and PR history before capture, but it does not check out an existing automation branch until after the focused producer test, repository-wide replay, and local additions-only artifact validation pass. This keeps repository-local actions, npm lifecycle behavior, and producer scripts sourced from `main` rather than from an unreviewed refresh PR branch.

If a target already has an open refresh PR and a new artifact was produced, the token-gated update step copies the validated artifact aside, points `core.hooksPath` at an empty temporary directory, checks out that branch, rebases it onto `origin/main`, revalidates the pre-existing PR diff as append-only target artifacts, restores the new artifact, and commits it. Disabling repository hooks before the unreviewed branch checkout prevents branch-controlled hook code from executing while the refresh token is available. This preserves unmerged append-only history. With no open PR, the workflow inspects the remote branch and PR history before starting from `origin/main`; closed-unmerged, orphaned, or otherwise ambiguous branch state fails for operator review.

Jobs use target-specific concurrency, stage only the target's evidence directory, run focused tests and repository-wide replay, and require the PR diff to contain additions only under that directory. They open or update a non-auto-merge PR only after those checks pass.

The PR records the snapshot identity, measured and unavailable metrics, adoption blockers, and the expected confirmatory or indeterminate effect. Automation never edits an overlay or grants an artifact score authority.

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
