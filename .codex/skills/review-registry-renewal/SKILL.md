---
name: review-registry-renewal
description: Renew, retire, or escalate expiring operational reviews, waivers, and calendars from fresh evidence. Use for expiry lookaheads, status reminders, or renewal issues. Not for Safety Score evidence.
---

# Review Registry Renewal

## Trigger And Exclusions

Use when a dated operational review, waiver, disposition, exclusion or calendar entry is expiring, expired or invalid: the `Dated-review expiry lookahead` section of `npm run digest:curation`, an admin `*_reviews_expiring`, `*_expired` or `*_invalid` status cause, a renewal follow-up, or a failing `npm run check:calendar-horizon`.

Not for:

- Safety Score evidence: anything under `shared/data/safety-score-v9/` (chain-maturity reviews included, although the digest lists them) and any `check:calendar-horizon` row that names a redemption config. Use [safety-score-curation](../safety-score-curation/SKILL.md).
- Reserve composition or attestation refreshes: [reserve-research](../reserve-research/SKILL.md).
- A native roster or perimeter fix that would end a supply carry, re-baseline or omitted-chain exclusion: [supply-plan-authoring](../supply-plan-authoring/SKILL.md).
- Quarantine, freeze or delist decisions and their `reviewBy` dates: the owner decides under the [lifecycle policy](../../../docs/listing-policy.md#lifecycle-policy).

## Classify The Operation

Pick the entry point, then give every entry exactly one decision: `retire`, `renew`, or `escalate`.

- **Cohort sweep:** all expired and lookahead rows from the digest.
- **Reminder triage:** entries named by a status cause inside its final reminder window.
- **Single entry:** one asset, adapter, event or chain from an issue.
- **Calendar horizon:** a market-hours calendar inside its renewal lead.

## Mandatory Core

- Read the [first checks](../../../docs/runbooks/review-renewal.md#first-checks) and the entry's lane section in [Review renewal](../../../docs/runbooks/review-renewal.md). For a registry the runbook does not cover, the registry file's type, validator and comments plus its owning doc are the contract: `npm run agent:route -- --file <registry file>`. `buildDatedReviewRegistries` in `scripts/maintenance/weekly-curation-digest.mjs` lists the registries; the source file wins.
- A renewal is a new review. Re-read live production state and the primary sources for the exact entry before touching a date. Never advance `expiresAt` alone, reuse the previous evidence, or renew to keep a dashboard green.
- Retire when the gap, feed failure, carry, drift, blind event or exclusion no longer exists: delete the entry. Escalate when the cause is a pipeline defect or a missing source: renewing hides it.
- Keep identity and match scope exact (asset, adapter, event ID, chain, error and warning set). A changed cause needs a new review, never a widened match.
- `reviewedAt` is the real, nonfuture review time. `expiresAt` stays within that registry's cap from its validator or the runbook. Evidence URLs are public HTTPS.
- An acknowledgement changes alert classification only. Never change published values, source clocks, price floors, freshness budgets, quarantine, or production review state, leases or checkpoints.
- A renewal takes effect only when the Worker carrying it is live. Compare the earliest expiry with the next release; [expiry re-arms alerts](../../../docs/runbooks/review-renewal.md#at-expiry) by design.
- A renewal neither satisfies nor extends a lifecycle or holder-exit deadline. Keep that deadline and its owner in the reason and report it.
- Authority: research, edit and commit on the task branch without a check-in. Stop and report instead of committing when primary sources conflict or are unreachable, the entry needs a longer window than its cap, the evidence points to termination or delisting, or an owning check fails for a reason the entry does not explain.

## Branch Reads And Actions

- **Cohort sweep:** run `npm run digest:curation`, group rows by registry, write the decision table, then edit.
- **Reminder triage:** read `causes.dataQuality` on admin `GET /api/status?refresh=live` and the lane payload the runbook names. Reminders fire only for acknowledgements in use; a dormant entry near expiry is a retire candidate.
- **On-chain evidence:** follow [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence).
- **Calendar horizon:** follow [Market-hours calendars](../../../docs/runbooks/review-renewal.md#market-hours-calendars); re-read the pinned sources before moving any date.
- **Registry suites:** suites pin entry IDs, counts and dates. Update the owning suite in the same change; add no sibling test file.

## Checks Owned By The Verifier

- The owning registry and status suites named under `Checks to consider` by `npm run agent:route -- --file <registry file>`, plus `npm run typecheck:worker`.
- `npm run digest:curation`: every handled row has left the expired and lookahead groups and none reports `(invalid)`.
- `npm run check:calendar-horizon` when a calendar moved.
- `git diff --check`.

## Completion Evidence

Report a table of registry, entry ID, decision, evidence URLs with retrieval time (pins for on-chain reads), old and new `reviewedAt` and `expiresAt`, and the cap applied. Add the next expiry date in each touched registry, checks run versus not run, whether the release carrying the change lands before the earliest expiry, and every open lifecycle decision. Publishing goes through [pharos-release-runner](../pharos-release-runner/SKILL.md) when asked.
