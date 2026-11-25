# Row Verdicts And Document Baselines

`scripts/maintenance/verify-failure-scenarios.ts` and `shared/lib/failure-scenario-checks/` win over this text; [Monthly re-verification and falsifier suspension](../../../../docs/process/failure-scenarios.md#monthly-re-verification-and-falsifier-suspension) owns the publication consequences.

## Row Verdicts

- **holds**: the tested premise remains true at the reported pin. Threshold checks may tolerate movement within the same boundary; retain the actual values. Holds is not proof of every claim in the text.
- **changed falsifier**: a decisive recorded fact or tested boundary drifted and the run exits non-zero. Inspect the evidence and meaning before concluding that the falsifier is `met`; the tool does not make that editorial decision.
- **changed figure**: an informational published `keyFigures` entry or `exposure` row moved, such as supply, pool inventory, or a sale quote. The row names the watched collection and label, reports observed versus published, and contributes to **figures to refresh**, not a decisive failure. Historical pinned figures are expected to differ from today's state; the maintainer decides whether to restate them, not automatically retire the note.
- **Sky governance bar**: `hat-approvals-bar` tests the named sitting hat, Chief's strict `approvals[candidate] > approvals[hat]` election rule and the recorded Chief → DSPause → PauseProxy route. It does not compare a daily-moving weight with a frozen minimum. The `hat-approval-weight` figure watches **Approvals to beat**, showing the exact pinned/current SKY approvals even when the rounded published figure has not moved; staking/voting drift is informational.
- **unavailable**: a read, baseline, provider, or document review was unavailable. Obtain the missing evidence through read-only sources or report the exact gap. This has its own count and never causes a non-zero exit by itself. Never treat it as holds, zero, or proof that the note remains valid; off-chain conditions may explicitly require a human to read an issuer disclosure or legal document.
- **unchecked**: no registered check covers the falsifier. It causes a non-zero exit and requires a check or explicit maintainer evidence review, never a silent pass. A chain report alone cannot establish counterparty, reserves, legal or other off-chain facts.
- **observation** rows are supplemental facts, not coverage of a falsifier. Review reported changes without mislabelling a separate off-chain condition as verified.
- **document watch**: a registered human-review route for the named falsifier, not a decisive condition check. `holds` means the cited source's normalized-text SHA-256, printed revision/date and URL/publisher match the reviewed baseline. PDFs also retain a byte hash so visual/font changes cannot evade imperfect text extraction. HTTP `Last-Modified` and `ETag` remain recorded corroborating evidence, but never change the verdict alone: CDN replicas can serve identical substance with different transport validators. Metadata drift appears under `observed.transportMetadataChanges`, including the old/new values. `changed` includes substance fingerprints and text-difference excerpts; source identity or PDF byte-hash changes also require review. The underlying legal, reserve, counterparty or recovery condition remains a human judgement. `unavailable` names the failed fetch/extraction or missing reviewed baseline and retains the human-reading reason. Publisher access blocks are recorded explicitly, never silently omitted.

The JSON summary separates decisive `falsifiers` counts from `figures.figuresToRefresh`, contextual `observations` counts, and `documents.unchanged` / `documents.changed` / `documents.unavailable`. Do not aggregate informational changed rows into a publication-invalidity verdict. A matching document fingerprint means the reviewed source text is unchanged, **not** that the condition was re-decided.

## Deliberate Document Baseline Refresh

Normal verification never writes `shared/data/failure-scenario-documents.json`. After a human reads a changed source, diffs the baseline's saved `normalizedText` against the current source, and decides what it means for the scenario, deliberately run:

```bash
npm run verify:failure-scenarios -- --refresh-documents
# Limit the reviewed refresh to one coin when appropriate:
npm run verify:failure-scenarios -- --coin <id> --refresh-documents
```

This flag records today's successful fingerprints and normalized text in the separate document baseline file, keyed by coin and falsifier ID, retaining every cited source. The report still compares against the pre-refresh baseline and names each `recorded` or `unavailable` refresh result. Failed fetches never overwrite an existing reviewed fingerprint; a source without any successful baseline retains its explicit unavailable reason. The next normal run compares against the deliberate refresh. Refreshing fingerprints is **not** approval, does not re-decide a condition, and never edits `data/failure-scenarios.json`. If source changes require scenario wording/status edits, use the normal maintainer review and re-approval path instead of masking that drift with a refresh.

## Maintainer Decisions

Review the full note, not just the summary. Record the pins and a decision with supporting row IDs, evidence, and unresolved gaps:

1. **Still holds**: tested premises remain valid, unchecked conditions have been manually reviewed, and no wording needs correction. Leave the content and approval untouched; retain the dated review report.
2. **Correct and re-approve**: factual drift or wording requires an edit but a defensible scenario remains. Propose the exact text and falsifier changes to the maintainer. Any edit to approved content (including falsifier evidence/status) invalidates the content hash and withholds publication until maintainer re-approval; do not automate approval or merely rewrite the hash.
3. **Retire**: a condition genuinely invalidates the failure path or evidence no longer supports publication. Present the rationale and proposed retirement/status change for the maintainer's decision. A falsifier flipping to `met` withholds the record at the next build even if its previous approval remains recorded. Do not keep a disproven record publishing by relabelling the condition.
