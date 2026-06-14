export const meta = {
  name: 'docs-verify-remediate',
  description: 'Apply adjudicated doc-vs-code fixes from findings.json, one agent per doc (disjoint files)',
  phases: [
    { title: 'Load', detail: 'read findings.json, group confirmed fixes by doc' },
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
const loaded = await agent(
  `Read agents/doc-verify/findings.json (repo root, a JSON array) and return it verbatim as {findings:[...]}. Do not modify, filter, or reorder. Structured output only.`,
  { label: 'load-findings', phase: 'Load', schema: FINDINGS_LOAD_SCHEMA, model: 'haiku' },
)
if (!loaded || !loaded.findings || !loaded.findings.length) throw new Error('findings load failed')

// Group by doc — one agent per doc so no two agents edit the same file.
const byDoc = {}
for (const f of loaded.findings) {
  ;(byDoc[f.doc] ||= []).push(f)
}
const docs = Object.keys(byDoc).sort()
log(`Applying ${loaded.findings.length} fixes across ${docs.length} docs (one agent per doc, disjoint files)`)

phase('Apply')
const SPECIAL_NOTE = {
  'docs/learn-mechanisms-page.md':
    'NOTE: several of this doc\'s findings overlap (lines 63/64/65/67/69/71 all describe the explainer anatomy). Treat src/app/learn/mechanisms/explainer-shell.tsx + src/app/learn/_shared/related-coins-list.tsx as ground truth and rewrite the affected "Page Anatomy"/sections list into ONE coherent, correctly-ordered description rather than applying conflicting line-by-line patches. The :63 adjudicatedDocFix carries the corrected full ordering; fold the smaller edits into it.',
}

function buildApplyPrompt(doc, findings) {
  return `You are applying verified documentation fixes to ONE file: ${doc}. Working dir is the repo root. Each fix below was confirmed against the actual code by an adversarial adjudication pass — the DOC is wrong and the CODE is the source of truth.

${SPECIAL_NOTE[doc] || ''}

FIXES (JSON):
${JSON.stringify(findings, null, 2)}

For each fix:
1. Read ${doc} and locate the stale claim at/near docLine (line numbers may have shifted slightly — match on the docQuote/content).
2. Quickly re-confirm the code evidence (codeEvidence cites file:line) with Read/Grep so you apply the TRUE current behavior, not a blindly-pasted string. If the code no longer matches whatCodeDoes (e.g. code changed since the audit), SKIP and say so.
3. Apply a MINIMAL, surgical Edit: replace only the wrong span, preserving the doc's surrounding prose, markdown structure, tables, and style. adjudicatedDocFix is the intended corrected meaning — adapt its wording to fit the sentence/table cell rather than dropping it in verbatim if that reads awkwardly. If it says DELETE, remove the stale sentence/clause cleanly.
4. Do NOT introduce new claims beyond the fix, do NOT reflow unrelated lines, do NOT fix things not in the list.

Rules: keep any cited file paths real (a CI check verifies doc source paths). Tailwind/code identifiers stay exact. Match heading/bullet/table conventions already in the file.

Return the structured result: one edits[] entry per fix (applied or skipped + a 1-line reason). Structured output only.`
}

const results = await parallel(
  docs.map((doc) => () =>
    agent(buildApplyPrompt(doc, byDoc[doc]), {
      label: `fix:${doc.replace('docs/', '')}`,
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
log(`Applied ${applied}, skipped ${skipped} across ${ok.length}/${docs.length} docs`)

return {
  docsProcessed: ok.length,
  totalDocs: docs.length,
  applied,
  skipped,
  skippedDetail,
  perDoc: ok.map((r) => ({ doc: r.doc, applied: r.appliedCount, skipped: r.skippedCount })),
}
