---
name: scenario-verification
description: Re-read pinned on-chain facts and watch documentary source fingerprints behind failure scenarios monthly, reporting drift without approving or changing scenario records automatically.
user_invocable: true
---

# Scenario Verification

## Authority and cadence

Run at least monthly, and after a known governance, custody, role, or contract change relevant to a published note. Approval is one-time, not time-limited. A monthly read is a drift report, not an approval renewal.

Read `docs/process/failure-scenarios.md` first. The record in `data/failure-scenarios.json`, the schemas and publication selector in `shared/lib/failure-scenarios.ts`, checks in `shared/lib/failure-scenario-checks/`, and reviewed document baselines in `shared/data/failure-scenario-documents.json` are authoritative. Do not hard-code a coin roster: enumerate the current registry and records. The verifier includes drafts so checks can be exercised before publication; clearly distinguish them from approved notes.

Only the maintainer runs `npm run scenarios:approve`. Agents must never invoke it, even with prior approval of research work. The verifier never writes `data/failure-scenarios.json` and must never broadcast a transaction.

## Collect a pinned report

1. Run `npm run verify:failure-scenarios` for the registered corpus. Use `-- --coin <id>` for a focused re-read.
2. For a machine-readable report, run `npm run verify:failure-scenarios -- --json`. Preserve reports and supporting evidence under ignored `agents/`; keep stdout JSON intact and command errors alongside it.
3. By default the runner resolves each required chain's head once before checks begin. The report records numeric heights, block hashes and timestamps. `-- --block <n>` overrides the height on **every required chain**: chain heights are independent, so a single height is not a shared cross-chain instant. Record which mode was used; never label an old override as today's head.
4. Read each coin's separate falsifier, published-figure, contextual-observation and document-watch sections (the JSON arrays are `falsifiers`, `figures`, `observations`, and `documents`), observed-versus-published values, reasons, pins and summary. Exit `1` means a decisive falsifier changed, a falsifier has no registered check or document-review route, or a runtime error; exit `2` means invalid CLI usage. Figure drift, contextual observations and document watches never fail the run. Unavailable reads are counted separately and also do **not** fail the run: they request human review, not a failure-path verdict. Therefore exit `0` is not evidence of complete verification or of an unchanged note; inspect every unavailable item.
5. The runner loads `.env.local` without printing credentials. To prefer an archive/log-capable provider, set an ordered, comma- or whitespace-separated `RPC_URLS_<chainId>` list, or a single `RPC_URL_<chainId>`. `ETHEREUM_RPC_URLS`/`ETHEREUM_RPC_URL` and `BSC_RPC_URLS`/`BSC_RPC_URL` are also supported; `RPC_URLS`/`RPC_URL` apply to Ethereum. The first defined chain-specific option takes precedence; configured providers precede the public fallback list. Ethereum defaults prefer Flashbots then dRPC. Fallback happens per request, not just at startup, and exhausted providers are reported with the chain/method. Deterministic execution reverts are preserved for checks that use them as evidence, not retried as transport failures.
6. Document fetching and HTML/PDF extraction happen only in the Node runner, never shared code. PDF sources require Poppler's `pdftotext` in `PATH`; missing extraction support produces `unavailable`, not an empty-text hash. HTML parsing does not run publisher scripts. Normalisation retains the main/body text, decodes entities, excludes navigation, executable/style content and the explicitly marked hidden nodes filtered by `documentText()`, adds block boundaries, applies Unicode NFC and collapses whitespace. It does not compute stylesheet visibility. Script timestamps and nonces, DOM build/session attributes, asset URLs and cache-busting query strings do not enter the text fingerprint; printed substantive dates, amounts and terms remain intact.

## Interpret every row

- **holds**: the tested premise remains true at the reported pin. Threshold checks may tolerate movement within the same boundary; retain the actual values. Holds is not proof of every claim in the text.
- **changed falsifier**: a decisive recorded fact or tested boundary drifted and the run exits non-zero. Inspect the evidence and meaning before concluding that the falsifier is `met`; the tool does not make that editorial decision.
- **changed figure**: an informational published `keyFigures` entry or `exposure` row moved, such as supply, pool inventory, or a sale quote. The row names the watched collection and label, reports observed versus published, and contributes to **figures to refresh**, not a decisive failure. Historical pinned figures are expected to differ from today's state; the maintainer decides whether to restate them, not automatically retire the note.
- **Sky governance bar**: `hat-approvals-bar` tests the named sitting hat, Chief's strict `approvals[candidate] > approvals[hat]` election rule and the recorded Chief → DSPause → PauseProxy route. It does not compare a daily-moving weight with a frozen minimum. The `hat-approval-weight` figure watches **Approvals to beat**, showing the exact pinned/current SKY approvals even when the rounded published figure has not moved; staking/voting drift is informational.
- **unavailable**: a read, baseline, provider, or document review was unavailable. Obtain the missing evidence through read-only sources or report the exact gap. This has its own count and never causes a non-zero exit by itself. Never treat it as holds, zero, or proof that the note remains valid; off-chain conditions may explicitly require a human to read an issuer disclosure or legal document.
- **unchecked**: no registered check covers the falsifier. It causes a non-zero exit and requires a check or explicit maintainer evidence review, never a silent pass. A chain report alone cannot establish counterparty, reserves, legal or other off-chain facts.
- **observation** rows are supplemental facts, not coverage of a falsifier. Review reported changes without mislabelling a separate off-chain condition as verified.
- **document watch**: a registered human-review route for the named falsifier, not a decisive condition check. `holds` means the cited source's normalized-text SHA-256, printed revision/date and URL/publisher match the reviewed baseline. PDFs also retain a byte hash so visual/font changes cannot evade imperfect text extraction. HTTP `Last-Modified` and `ETag` remain recorded corroborating evidence, but never change the verdict alone: CDN replicas can serve identical substance with different transport validators. Metadata drift appears under `observed.transportMetadataChanges`, including the old/new values. `changed` includes substance fingerprints and text-difference excerpts; source identity or PDF byte-hash changes also require review. The underlying legal, reserve, counterparty or recovery condition remains a human judgement. `unavailable` names the failed fetch/extraction or missing reviewed baseline and retains the human-reading reason. Publisher access blocks are recorded explicitly, never silently omitted.

The JSON summary separates decisive `falsifiers` counts from `figures.figuresToRefresh`, contextual `observations` counts, and `documents.unchanged` / `documents.changed` / `documents.unavailable`. Do not aggregate informational changed rows into a publication-invalidity verdict. A matching document fingerprint means the reviewed source text is unchanged, **not** that the condition was re-decided.

Per-coin research and the original measuring scripts live under `agents/how-does-x-break/verification/<slice>/`. For crvUSD, relevant slices include `convex-control-review`, `convex-routes`, `issuance-path-replay`, and `crvusd-bound-qualifier`. Discover the other slice directories and current record source IDs rather than assuming a fixed roster. These ignored evidence files may be absent in a fresh checkout: retrieve retained evidence or reconstruct the read from the record's cited sources, and disclose any missing baseline. Scratch evidence is not a durable publication authority.

## Deliberately refresh reviewed document baselines

Normal verification never writes `shared/data/failure-scenario-documents.json`. After a human reads a changed source, diffs the baseline's saved `normalizedText` against the current source, and decides what it means for the scenario, deliberately run:

```bash
npm run verify:failure-scenarios -- --refresh-documents
# Limit the reviewed refresh to one coin when appropriate:
npm run verify:failure-scenarios -- --coin usdc-circle --refresh-documents
```

This flag records today's successful fingerprints and normalized text in the separate document baseline file, keyed by coin and falsifier ID, retaining every cited source. The report still compares against the pre-refresh baseline and names each `recorded` or `unavailable` refresh result. Failed fetches never overwrite an existing reviewed fingerprint; a source without any successful baseline retains its explicit unavailable reason. The next normal run compares against the deliberate refresh. Refreshing fingerprints is **not** approval, does not re-decide a condition, and never edits `data/failure-scenarios.json`. If source changes require scenario wording/status edits, use the normal maintainer review and re-approval path instead of masking that drift with a refresh.

## Prepare a maintainer decision per coin

Review the full note, not just the summary. Record the pins and a decision with supporting row IDs, evidence, and unresolved gaps:

1. **Still holds**: tested premises remain valid, unchecked conditions have been manually reviewed, and no wording needs correction. Leave the content and approval untouched; retain the dated review report.
2. **Correct and re-approve**: factual drift or wording requires an edit but a defensible scenario remains. Propose the exact text and falsifier changes to the maintainer. Any edit to approved content (including falsifier evidence/status) invalidates the content hash and withholds publication until the maintainer approves the corrected, verified record again. Do not automate approval or merely rewrite the hash.
3. **Retire**: a condition genuinely invalidates the failure path or evidence no longer supports publication. Present the rationale and proposed retirement/status change for the maintainer's decision. A falsifier flipping to `met` withholds the record at the next build, even if its previous approval remains recorded. Do not keep a disproven record publishing by relabelling the condition.

Deliver a concise per-coin decision table with `still holds`, `correct and re-approve`, `retire`, or `undecided: evidence gap`, plus the read provenance and action owner. Monthly reports are advisory; the maintainer decides all record edits, re-approvals and retirements.
