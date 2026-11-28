# Closure And Batching Rules

The plan carries these for the executor. Apply them when ordering lanes and writing closure criteria.

## Batching And Order

1. Run lanes in parallel isolated worktrees, review each diff, then integrate compatible lanes into few release PRs with one commit per lane. Every merge makes the other open PRs update and rerun CI, so per-lane PRs multiply gate time.
2. Land first, in this order: a red nightly, reviews or waivers that expire before the next session, test-corpus debt ([Test corpus budget](../../../../docs/testing.md#test-corpus-budget); the override label is owner-only), and any secret-scan policy entry a later PR needs, because the scan reads policy from the frozen base ([CI guardrails](../../../../docs/security-governance.md#ci-guardrails)).
3. Lanes that share a generated artifact or a methodology version are batched into one regeneration and one version bump per domain, or strictly serialized ([ADR-3](../../../../docs/architecture.md#adr-3)). Name the shared file in the plan.
4. A `design-first` lane delivers a written design, gets it reviewed and owner-approved, and only then builds.
5. Curation and data lanes that depend on a scoring or schema change wait until that change has merged and its artifacts are regenerated.
6. Name prerequisites before the first lane starts: installed dependencies, tool logins that can expire mid-pass, owner-only steps (labels, Cloudflare provisioning, dashboard changes) and dirty files to leave untouched.

## Review

- Every write lane gets an independent read-only diff review before integration; without delegation, a disclosed sequential self-review. No lane merges unreviewed.
- Cap review at 3 rounds per lane. Major findings after round 3 mean the lane is mis-scoped: hold it, then re-scope or escalate to the owner.

## Deploy Windows

[Operational Acceptance](../../../../docs/deployment-process.md#operational-acceptance) owns the windows; it wins over this summary.

- Plan no release that changes Safety Score inputs or its evaluation-build manifest to activate between the hourly `:16` preparation and the `:22` publication, and observe the next accepted publication before the next such release. An urgent fix that must land inside the window is named as urgent in the plan, with the publication it is expected to skip.
- A paired Liquidity/Pricing methodology release deploys both Workers in one window and avoids `:08`–`:17`.
- A green deploy is activation proof only. Each release names the first production execution that proves it. If an unmonitored check falls after the session, keep the owning issue open with a moved `Due:`, or bundle the pass's post-session acceptance into at most one rollout issue with rolling `Due:`. Skip filing when `post-deploy-acceptance`, `nightly-validation`, or `cron-liveness` already catches failure.

## Closure Audit

1. Close an issue when every `Done when` clause is verified by evidence read after the change is live, or when closing a `close-redundant` row with a pointer to its surviving issue or standing tracker. Closing comments cite evidence per clause (run IDs, UTC times, observed values) within the public-repo limits.
2. A partial advance keeps the existing issue open, comments what moved and what remains, and moves its `Due:` line to the earliest remaining gate — never close an issue solely to replace it with spin-off tickets.
3. Keep **one issue per theme or multi-PR rollout**, advancing `Due:` to the earliest remaining gate. Separate issues only for genuinely unrelated domains. Never open a child follow-up while its owning parent stays open, and never duplicate `#945`, `#1302`, `npm run digest:curation`, or dated registry fields (`reviewBy`, `expiresAtSec`).
4. Executor filing gate: fix material review findings before merge; leave non-blocking council polish, optional refactors, and unverified hypotheses in the PR comment or closure summary — do not file them as `ops:followup`. Before opening any new issue, search open issues (`gh issue list --state open`) and standing trackers so findings fold into existing owners.
5. The executor's first step posts each settled ruling as a dated comment, `Owner decision, YYYY-MM-DD: …`, on the owning issue.
6. The closure summary reconciles every plan row as closed, advanced, excluded, held or reopened, reports net issue delta (`closed − newly filed`), and records post-merge rework and later waves. Update it whenever work continues after it was written.
7. Remove the worktrees and bulky scratch the pass created ([Cleanup Rule](../../../../docs/process/agent-artifacts.md#cleanup-rule)); never unrelated dirty files.
