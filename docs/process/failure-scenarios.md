# Curated Failure Scenarios

The dossier's **How does X break?** section is a curated, hypothetical failure chain, not a simulator, a prediction, an observed compromise, or a Safety Score input. Its editorial source is `data/failure-scenarios.json`, keyed by tracked catalog ID. The types live in `shared/types/failure-scenarios.ts`; schema, content identity, and publication selection live in `shared/lib/failure-scenarios.ts`.

The lifecycle is **draft → verify → one-time maintainer approval → monthly re-verification**. Approval binds the exact content; the monthly `scenario-verification` skill reports changes to the recorded facts for a maintainer decision, rather than renewing approval automatically.

## Draft and verification

1. Author or revise a record with `review.status: "draft"`. Agents may research and edit drafts, but **must never write approval stamps or run the approval command**. Tentative approval in a note does not publish anything.
2. Verify every relevant permission path, source, deployment, and falsifier. Give each falsifier a stable, unique `id` within its record so later checks can compare the same condition. Pin chain, block, and observation date; distinguish on-chain state, documented behavior, inference, and unverified claims. Keep the hypothetical premise explicit and retain qualifications where permissions or downstream consequences remain unresolved.
3. Run `npm run check:failure-scenarios` and the focused behavior tests (`npx vitest run shared/lib/__tests__/failure-scenarios.test.ts`). The check accepts drafts but rejects malformed records, unknown tracked IDs, key/ID mismatches, duplicate stage/source/falsifier IDs, dangling source references, and missing or reversed window boundaries. Nested objects reject unknown fields. Observation dates accept valid ISO calendar dates or offset-aware ISO timestamps; `reviewedAt` requires an offset-aware ISO timestamp. Contract targets require 20-byte hex EVM addresses, and sources require HTTP(S) URLs.
4. Ask the maintainer to review the **exact content**, including evidence limits and falsifiers. A draft is only previewable in development with the unmistakable **Draft — not approved** marker. Production static export never ships drafts.

Alternative entry routes use the optional `branchPoint`: at least two uniquely identified branches, each with at least one stage, inserted after a non-final trunk stage named by `afterStageId`. Branch stages rejoin at the following trunk stage; they are alternatives, not actions executed one after another. Stage IDs must be unique across the trunk and every branch. Required `keyFigures` carry value, label, evidence status, and source IDs; their references and all branch-stage references resolve against the scenario's sources.

Window endpoints may name trunk or branch stages. For deterministic ordering validation, the flattened order is the trunk prefix through `afterStageId`, then every branch's stages in authored branch order, then the remaining trunk. This ordering is a reference-validation convention, not an assertion that alternative branches happen sequentially. Missing endpoints and windows running backward in that order are rejected.

## One-time maintainer approval

Only the maintainer runs:

```bash
npm run scenarios:approve -- crvusd-curve --reviewer "Maintainer name"
```

`scripts/maintenance/approve-failure-scenario.ts` validates the entire source file and refuses a selected scenario with any `met` falsifier. It prints the canonical content (excluding `review`), reviewer, and SHA-256 digest before requesting the explicit interactive response `approve <coinId>`. Without a TTY it refuses to continue. A maintainer may deliberately supply `--yes` to bypass only the confirmation prompt; validation and content output still run. Cancellation makes no changes. If the source file changes during confirmation, approval aborts rather than approving unseen content.

The script replaces the selected record's `review` with `status: "approved"`, `reviewedBy`, `reviewedAt`, and `contentSha256`. This is a one-time approval of that exact content. The dossier displays the reviewed date for an approved record. Approval remains valid while its content is unchanged, its reviewed date is not in the future, and none of its falsifiers is met. Any content edit requires fresh verification, exact-content review, and maintainer re-approval; approval is never written or renewed by an agent.

## Content binding and fail-closed publication

The digest is SHA-256 of UTF-8 canonical JSON for the complete record **minus `review`**. Object keys are sorted recursively; array order remains meaningful. The implementation reuses `shared/lib/stable-json.ts` and `shared/lib/sha256.ts`, which are synchronous and runtime-neutral: no Node-only crypto import, WebCrypto availability, asynchronous server API, or new hash dependency is required.

`selectFailureScenario` returns a record only after validating its schema and key/ID consistency. Production publication additionally requires all of the following:

- approved status and a content-matching hash;
- a `reviewedAt` that is not in the future;
- no falsifier with `status: "met"`.

Malformed, edited, future-dated, or falsified approvals return no scenario and no navigation pill. Preview permission does not rescue an invalid approved record. A met falsifier also suppresses a draft preview. Unverified falsifiers remain visibly qualified evidence gaps; they are not silently treated as verified negative findings.

`npm run check:failure-scenarios` uses the same publication conditions for every approved record and exits nonzero on any violation. Its focused registration in `docs/doc-ownership.json` selects this gate and the behavior tests for scenario data/logic changes without adding unrelated release gates.

## Monthly re-verification and falsifier suspension

Run the `scenario-verification` skill monthly to re-read the facts behind each note and report drift against its recorded falsifier conditions. Preserve falsifier IDs across checks. The report should distinguish a changed fact, a met condition, an unchanged condition, and an unverified read, with the chain, block, observation date, and evidence needed for the maintainer to assess the finding. A failed or unavailable read is not evidence that a condition remains unmet.

The routine reports findings; it does not approve notes or silently edit the approved content. The maintainer decides whether to keep an unchanged note, revise and re-approve it, or retire it. Any content change, including a source, evidence pin, ordering, or falsifier status change, invalidates the existing hash. Return edited content to draft, verify it, and obtain maintainer re-approval; never manually patch the digest. Even an updated evidence pin requires re-approval because it is part of the content.

When a falsifier becomes met, record that finding immediately and withdraw the record to draft or retire it. Publication selection suppresses it even if an otherwise matching approval stamp exists; the CI gate fails until the approved record is withdrawn to draft or revised and re-approved by the maintainer.

Because the dossier is a static export, selection runs at build time, not on every page view. A local data flip does not change an already deployed export: a withheld record only drops at the next rebuild and redeploy. Rebuild and redeploy promptly to remove the section after a finding. Deployment remains a separate maintainer-owned workflow.
