# Pharos Documentation Audit Reviewers

Use these prompts with bounded reviewer/writer capabilities when the user authorizes delegation. If delegation is unavailable, run discovery and skeptical source reopening sequentially and label the result as a single-agent review. Existing explicit remediation authorization persists for its stated scope. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`.

## Documentation Truth Auditor

Capability: spawn a read-only reviewer.

```text
Audit <DOC_OR_DOC_FAMILY> against source. Do not edit files.

Read docs/process/agent-start-here.md, docs/doc-ownership.json, docs/process/agent-artifacts.md, the target docs, and routed source/local imports.

Return false/stale claims with source-backed corrections, missing required updates, suspect source paths, and exact doc checks. Produce edit-ready findings, not rewritten prose.
```

## Methodology Consistency Reviewer

Capability: spawn a read-only reviewer.

```text
Verify methodology docs and structured changelog entries against the runtime scoring/source change. Do not edit files.

Read the router/ownership registry, docs/methodology-page.md, the owning methodology doc/changelog directory, and relevant runtime sources.

Check versions, thresholds/weights/formulas, page copy, and changelog presence. Return blocking drift first with exact source-backed corrections.
```

## Documentation Fix Writer

Capability: spawn a narrowly scoped docs writer.

```text
Apply only the assigned documentation fixes. Preserve unrelated work.

Assigned write scope: <DOC PATHS ONLY>
Findings: <FINDINGS>

Verify claims against source, edit only assigned docs, avoid product/generated files, run narrow doc checks when useful, and return changed paths plus remaining issues.
```

## Scalable corpus mode

### Inventory and partition

Enumerate the whole corpus with `getVerifiedDocFiles(repoRoot)` from `scripts/lib/doc-files.mts`. Attach ownership hints from `docs/doc-ownership.json` afterward: resolve object references through `path` and carry mapping labels, source globs, rules, and `alsoRead` context as metadata. Keep unmapped documents in scope; report every skipped document and reason. A targeted request still selects only its requested subset. Verify every selected path exists. Keep only the requested corpus (normally `docs/` and `README.md`); treat agent-guidance paths as a separate assigned family when they are explicitly in scope. Partition the rows into N disjoint sets so no document has two writers. Each row should include `path`, `category`, line count, source hints, and depth.

Depth is `light` for timeline archives (check only current/latest behavior and current claims), `targeted` for `docs/api-reference.md` (use its navigation block and offsets; skip generated markers), and `deep` for ordinary docs. A reviewer may receive one set or one document at a time, but must return findings for its assigned paths only.

### Verifier contract

The read-only verifier checks semantic claims against opened source. CI already owns file paths (`npm run check:doc-source-paths`), internal links (`npm run check:verified-doc-links`), methodology version strings (`npm run check:doc-sync`), the generated agent mirror, and generated API artifacts (`npm run check:generated-artifacts -- --only=api-reference,openapi,postman`); do not report those. In scope are formulas/thresholds/bands/defaults, mutable enumerations, environment names, D1 schema, cron cadence/budgets, hand-written API fields/status/cache behavior, conditionals, and function/module behavior. Ignore rationale, roadmap/history, and style. Treat docs as hypotheses; no source evidence means no finding.

Return structured data in this shape:

```text
{ doc, claimsChecked, docAccurate, findings: [
  { docLine, docQuote, claimType, whatDocSays, whatCodeDoes,
    codeEvidence, severity, confidence, classification, proposedDocFix }
] }
```

`classification` is `doc-wrong`, `code-wrong`, or `ambiguous`; evidence names the source path and line. `docQuote` is short, and `proposedDocFix` is a concrete replacement, `DELETE`, or concise instruction.

Use these `claimType` values: `formula-threshold-constant`, `enumeration-list`, `env-var`, `d1-table-column`, `cron-schedule`, `api-field-shape`, `behavior-conditional`, `file-symbol-behavior`, `count-non-headline`, or `other`. Severity is `high`, `medium`, or `low`; confidence is a number from 0 through 1.

### Adjudication, synthesis, and remediation

For each document with candidates, an independent skeptic rereads the document and cited source. Default to `REJECTED`; use `CONFIRMED` only for a clear contradiction and `REVISED` for a real discrepancy whose description or fix needs correction. Return `doc`, `adjudicated[]`, and for each item the line, quote when useful, verdict, reject reason when rejected, final classification, code behavior/evidence, severity, confidence, and final doc fix. A code-wrong result is a flag, never a code edit.

The parent deduplicates by document, line, and short quote. An item is auto-fixable only when classification is `doc-wrong`, confidence is at least 0.7, and the fix is concrete and non-investigative; everything else needs a decision. In explicit remediation mode, partition auto-fixable items by document and give each writer only that document. The writer reopens the evidence, skips stale candidates, edits docs only, and returns `{ doc, appliedCount, skippedCount, edits[] }`. No model performs the final serialization or broad write.
