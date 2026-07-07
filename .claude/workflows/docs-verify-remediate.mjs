export const meta = {
  name: 'docs-verify-remediate',
  description: 'Apply adjudicated doc-vs-code fixes from findings.json, one agent per doc (disjoint files)',
  phases: [
    { title: 'Load', detail: 'read findings (pre-split index via args, or whole findings.json), group by doc' },
    { title: 'Apply', detail: 'one agent per doc: re-check code, apply minimal faithful edits' },
  ],
}

const FINDINGS_LOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          doc: { type: 'string' },
          docLine: { type: 'integer' },
          partition: { type: 'string' },
          finalClassification: { type: 'string' },
          severity: { type: 'string' },
          confidence: { type: 'number' },
          whatCodeDoes: { type: 'string' },
          codeEvidence: { type: 'string' },
          adjudicatedDocFix: { type: 'string' },
        },
        required: ['doc', 'docLine', 'adjudicatedDocFix'],
      },
    },
  },
  required: ['findings'],
}

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc: { type: 'string' },
    appliedCount: { type: 'integer' },
    skippedCount: { type: 'integer' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          docLine: { type: 'integer' },
          status: { type: 'string', enum: ['applied', 'skipped'] },
          reason: { type: 'string', description: 'for skipped: why; for applied: a 1-line note on what changed' },
        },
        required: ['docLine', 'status', 'reason'],
      },
    },
  },
  required: ['doc', 'appliedCount', 'skippedCount', 'edits'],
}

phase('Load')
// Preferred path: caller passes a pre-split docsIndex ([{doc, findingsPath}]) so each
// apply agent reads only its own small fixes file — avoids a haiku whole-findings.json
// load silently truncating a large findings array (repo memory: docs-remediate-robust).
let heldForReview = (args && args.heldForReview) || 0
let entries // [{ doc, findingsPath?, findings? }]
if (args && args.docsIndex && args.docsIndex.length) {
  entries = args.docsIndex.map((e) => ({ doc: e.doc, findingsPath: e.findingsPath }))
  log(`Applying pre-split auto-fixable fixes across ${entries.length} docs (each agent reads its own findings file); held ${heldForReview} for human review`)
} else {
  const loaded = await agent(
    `Read agents/doc-verify/findings.json (repo root, a JSON array) and return it verbatim as {findings:[...]}. Do not modify, filter, or reorder. Structured output only.`,
    { label: 'load-findings', phase: 'Load', schema: FINDINGS_LOAD_SCHEMA, model: 'haiku' },
  )
  if (!loaded || !loaded.findings || !loaded.findings.length) throw new Error('findings load failed')
  const isAutoFixableDocFinding = (f) =>
    f.partition === 'auto-fixable' && f.finalClassification === 'doc-wrong' && typeof f.confidence === 'number' && f.confidence >= 0.7
  const autoFixableFindings = loaded.findings.filter(isAutoFixableDocFinding)
  heldForReview = loaded.findings.length - autoFixableFindings.length
  if (!autoFixableFindings.length) {
    log(`No auto-fixable doc-wrong findings found; held ${heldForReview} findings for human review`)
    return { docsProcessed: 0, totalDocs: 0, applied: 0, skipped: 0, skippedDetail: [], perDoc: [], heldForReview }
  }
  const byDoc = {}
  for (const f of autoFixableFindings) (byDoc[f.doc] ||= []).push(f)
  entries = Object.keys(byDoc).sort().map((doc) => ({ doc, findings: byDoc[doc] }))
  log(`Applying ${autoFixableFindings.length} auto-fixable doc-wrong fixes across ${entries.length} docs; held ${heldForReview} findings for human review`)
}

phase('Apply')
const SPECIAL_NOTE = {
  'docs/learn-mechanisms-page.md':
    'NOTE: several of this doc\'s findings overlap (they describe the explainer anatomy/section ordering). Treat src/app/learn/mechanisms/explainer-shell.tsx + src/app/learn/_shared/related-coins-list.tsx as ground truth and rewrite the affected "Page Anatomy"/sections list into ONE coherent, correctly-ordered description rather than applying conflicting line-by-line patches.',
}

function buildApplyPrompt(entry) {
  const doc = entry.doc
  const fixesBlock = entry.findingsPath
    ? `Your fixes for this doc are in a JSON file. FIRST use Read on: ${entry.findingsPath}\nIt is a JSON array of fix objects, each with: docLine, docQuote (verbatim stale doc text), whatCodeDoes, codeEvidence (file:line), adjudicatedDocFix (intended correction).`
    : `FIXES (JSON):\n${JSON.stringify(entry.findings, null, 2)}`
  return `You are applying verified documentation fixes to ONE file: ${doc}. Working dir is the repo root. Each fix was confirmed against the actual code by an adversarial adjudication pass — the DOC is wrong and the CODE is the source of truth.

${SPECIAL_NOTE[doc] || ''}

${fixesBlock}

For each fix:
1. Read ${doc} and locate the stale claim at/near docLine (line numbers may have shifted slightly — match on the docQuote/content).
2. Quickly re-confirm the code evidence (codeEvidence cites file:line) with Read/Grep so you apply the TRUE current behavior, not a blindly-pasted string. If the code no longer matches whatCodeDoes (e.g. code changed since the audit), SKIP and say so.
3. Apply a MINIMAL, surgical Edit: replace only the wrong span, preserving the doc's surrounding prose, markdown structure, tables, and style. adjudicatedDocFix is the intended corrected meaning — adapt its wording to fit the sentence/table cell rather than dropping it in verbatim if that reads awkwardly. If it says DELETE, remove the stale sentence/clause cleanly.
4. Do NOT introduce new claims beyond the fix, do NOT reflow unrelated lines, do NOT fix things not in the list.

Rules: keep any cited file paths real (a CI check verifies doc source paths). Tailwind/code identifiers stay exact. Match heading/bullet/table conventions already in the file.

Return the structured result: one edits[] entry per fix (applied or skipped + a 1-line reason). Structured output only.`
}

const results = await parallel(
  entries.map((entry) => () =>
    agent(buildApplyPrompt(entry), {
      label: `fix:${entry.doc.replace('docs/', '')}`,
      phase: 'Apply',
      schema: APPLY_SCHEMA,
      model: 'sonnet',
    }),
  ),
)

const ok = results.filter(Boolean)
const applied = ok.reduce((n, r) => n + (r.appliedCount || 0), 0)
const skipped = ok.reduce((n, r) => n + (r.skippedCount || 0), 0)
const skippedDetail = ok.flatMap((r) => (r.edits || []).filter((e) => e.status === 'skipped').map((e) => `${r.doc}:${e.docLine} — ${e.reason}`))
log(`Applied ${applied}, skipped ${skipped} across ${ok.length}/${entries.length} docs; held ${heldForReview} findings for human review`)

return {
  docsProcessed: ok.length,
  totalDocs: entries.length,
  applied,
  skipped,
  skippedDetail,
  perDoc: ok.map((r) => ({ doc: r.doc, applied: r.appliedCount, skipped: r.skippedCount })),
  heldForReview,
}
