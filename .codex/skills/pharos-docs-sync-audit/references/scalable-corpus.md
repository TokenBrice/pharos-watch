# Scalable corpus audit

Use for a broad semantic audit of the verified corpus, with or without delegation. Reviewers are bounded and read-only; a writer edits only its assigned documents after remediation is authorized, and an existing explicit authorization persists for its stated scope. Without delegation, run the same stages sequentially and label the result a single-agent review.

## Inventory And Partition

Enumerate the whole corpus with `getVerifiedDocFiles(repoRoot)` from `scripts/lib/doc-files.mts`. Attach ownership hints from `docs/doc-ownership.json` afterward: resolve object references through `path` and carry mapping labels, source globs, rules, and `alsoRead` context as metadata. Keep unmapped documents in scope; report every skipped document and reason. A targeted request still selects only its requested subset. Verify every selected path exists. Keep only the requested corpus (normally `docs/` and `README.md`); treat agent-guidance paths as a separate assigned family when they are explicitly in scope. Partition the rows into N disjoint sets so no document has two writers. Each row should include `path`, `category`, line count, source hints, and depth.

If an expected row count is supplied, fail when the loaded inventory is shorter. Do not invent a second filename roster or commit an inventory manifest.

Depth is `light` for timeline archives (check only current/latest behavior and current claims), `targeted` for `docs/api-reference.md` (use its navigation block and offsets; skip generated markers), and `deep` for ordinary docs. A reviewer may receive one set or one document at a time, but must return findings for its assigned paths only.

## Verifier Contract

The read-only verifier checks semantic claims against opened source. CI already owns file paths and internal links (`npm run check:verified-doc-links`); managed `<!-- GENERATED-START: ... -->` contract blocks, the lane-freshness matrix, isolate-local state docs and methodology versions (`npm run check:doc-sync`); and generated API artifacts (`npm run check:generated-artifacts -- --only=api-reference,openapi,postman`). Do not report those. In scope are formulas/thresholds/bands/defaults, mutable enumerations, environment names, D1 schema, cron cadence/budgets, hand-written API fields/status/cache behavior, conditionals, and function/module behavior. Ignore rationale, roadmap/history, and style. Treat docs as hypotheses; no source evidence means no finding.

Return structured data in this shape:

```text
{ doc, claimsChecked, docAccurate, findings: [
  { docLine, docQuote, claimType, whatDocSays, whatCodeDoes,
    codeEvidence, severity, confidence, classification, proposedDocFix }
] }
```

`classification` is `doc-wrong`, `code-wrong`, or `ambiguous`; evidence names the source path and line. `docQuote` is short, and `proposedDocFix` is a concrete replacement, `DELETE`, or concise instruction.

Use these `claimType` values: `formula-threshold-constant`, `enumeration-list`, `env-var`, `d1-table-column`, `cron-schedule`, `api-field-shape`, `behavior-conditional`, `file-symbol-behavior`, `count-non-headline`, or `other`. Severity is `high`, `medium`, or `low`; confidence is a number from 0 through 1.

## Adjudication, Synthesis And Remediation

For each document with candidates, an independent skeptic rereads the document and cited source. Default to `REJECTED`; use `CONFIRMED` only for a clear contradiction and `REVISED` for a real discrepancy whose description or fix needs correction. Return `doc`, `adjudicated[]`, and for each item the line, quote when useful, verdict, reject reason when rejected, final classification, code behavior/evidence, severity, confidence, and final doc fix. A code-wrong result is a flag, never a code edit.

The parent deduplicates by document, line, and short quote. An item is auto-fixable only when classification is `doc-wrong`, confidence is at least 0.7, and the fix is concrete and non-investigative; everything else needs a decision. In explicit remediation mode, partition auto-fixable items by document and give each writer only that document. The writer reopens the evidence, skips stale candidates, edits docs only, and returns `{ doc, appliedCount, skippedCount, edits[] }`. No model performs the final serialization or broad write.
