export const meta = {
  name: 'docs-audit',
  description: 'Change-aware full-corpus docs-vs-code audit: verify every doc, opus-tier the docs owning the last 24h of code changes, adversarially adjudicate, synthesize',
  phases: [
    { title: 'Load', detail: 'read the doc manifest (path, category, depth, sourceHints, notes)' },
    { title: 'Verify', detail: 'one agent per doc: extract code-checkable claims, locate code, surface discrepancies (opus for hot docs, sonnet for stable)' },
    { title: 'Adjudicate', detail: 'opus skeptic re-verifies each finding against code; default REJECTED' },
    { title: 'Synthesize', detail: 'dedupe, split auto-fixable vs needs-decision, write dated report.md + findings.json' },
  ],
}

// ---------------------------------------------------------------------------
// CI ALREADY GUARDS THESE — every agent must treat them as OUT OF SCOPE:
//  - file-path citations in docs            (check:doc-source-paths, passing)
//  - internal doc link targets              (check:verified-doc-links, passing)
//  - 26 headline aggregate counts           (check:doc-counts, passing)
//  - methodology version STRINGS            (check:doc-sync, passing) e.g. "v8.292"
//  - AGENTS.md <-> CLAUDE.md sync            (check:agent-doc-sync, passing)
//  - the generated HTTP contract in api-reference.md (check:docs-api-reference: current)
// The workflow targets SEMANTIC / BEHAVIORAL claims that no CI guards.
// ---------------------------------------------------------------------------

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc: { type: 'string' },
    claimsChecked: { type: 'integer', description: 'how many concrete claims you located code for and checked' },
    docAccurate: { type: 'boolean', description: 'true if you found no discrepancies' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          docLine: { type: 'integer' },
          docQuote: { type: 'string', description: 'verbatim doc text, <= 240 chars' },
          claimType: {
            type: 'string',
            enum: ['formula-threshold-constant', 'enumeration-list', 'env-var', 'd1-table-column', 'cron-schedule', 'api-field-shape', 'behavior-conditional', 'file-symbol-behavior', 'count-non-headline', 'other'],
          },
          whatDocSays: { type: 'string' },
          whatCodeDoes: { type: 'string' },
          codeEvidence: { type: 'string', description: 'file:line plus a short code quote that proves whatCodeDoes' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          confidence: { type: 'number', description: '0..1; your confidence the code truly contradicts the doc' },
          classification: { type: 'string', enum: ['doc-wrong', 'code-wrong', 'ambiguous'] },
          recentlyChanged: { type: 'boolean', description: 'true if this discrepancy is in code that changed in the last 24h (see CHANGED CONTEXT)' },
          proposedDocFix: { type: 'string', description: 'concrete replacement wording, or DELETE, or a short instruction' },
        },
        required: ['docLine', 'docQuote', 'claimType', 'whatDocSays', 'whatCodeDoes', 'codeEvidence', 'severity', 'confidence', 'classification', 'proposedDocFix'],
      },
    },
  },
  required: ['doc', 'docAccurate', 'findings'],
}

const ADJUDICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc: { type: 'string' },
    adjudicated: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          docLine: { type: 'integer' },
          docQuote: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REVISED', 'REJECTED'] },
          rejectReason: { type: 'string', description: 'required when REJECTED: why the doc is actually fine / why the finding is wrong' },
          finalClassification: { type: 'string', enum: ['doc-wrong', 'code-wrong', 'ambiguous'] },
          whatCodeDoes: { type: 'string' },
          codeEvidence: { type: 'string', description: 'file:line you personally re-opened to confirm' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          confidence: { type: 'number' },
          recentlyChanged: { type: 'boolean' },
          adjudicatedDocFix: { type: 'string', description: 'final exact replacement wording for the doc, or DELETE' },
        },
        required: ['docLine', 'verdict', 'finalClassification', 'whatCodeDoes', 'codeEvidence', 'severity', 'confidence', 'adjudicatedDocFix'],
      },
    },
  },
  required: ['doc', 'adjudicated'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    totalConfirmed: { type: 'integer' },
    autoFixableCount: { type: 'integer' },
    needsDecisionCount: { type: 'integer' },
    recentlyChangedCount: { type: 'integer' },
    bySeverity: { type: 'object', additionalProperties: true },
    docsWithIssues: { type: 'integer' },
    reportPath: { type: 'string' },
    findingsJsonPath: { type: 'string' },
    headline: { type: 'array', items: { type: 'string' }, description: 'up to 14 one-line summaries of the most important confirmed issues' },
  },
  required: ['totalConfirmed', 'autoFixableCount', 'needsDecisionCount', 'reportPath', 'findingsJsonPath', 'headline'],
}

const OUT_OF_SCOPE = `OUT OF SCOPE — CI already guards these, do NOT report them:
- existence of file paths cited in the doc (check:doc-source-paths passes)
- internal markdown link targets (check:verified-doc-links passes)
- headline aggregate counts: total tracked/active/frozen stablecoin counts, reserve-adapter count, archetype count, and similar dashboard totals (check:doc-counts passes)
- methodology version STRINGS like "v8.292"/"v6.09" (check:doc-sync passes) — but DO check the formulas/weights/thresholds/bands those versions describe
- AGENTS.md vs CLAUDE.md wording sync (check:agent-doc-sync passes)
- the generated HTTP request/response catalogue in api-reference.md (it is generated and verified current)`

const VERIFY_RULES = `WHAT COUNTS AS A DISCREPANCY (in scope):
- a stated formula, weight, threshold, band boundary, cap, default value, or constant that differs from the code
- an enumerated list (sources, providers, chains, signals, columns, states, fields, steps, kill-switches, venues, reserve adapters) that is wrong, incomplete, or includes items the code dropped
- an env var / binding / secret name that the code does not read, or a renamed one
- a D1 table or column name, or schema claim, that differs from migrations / store code
- a cron schedule, cadence, trigger slot, or connection budget that differs from cron-jobs.ts / scheduled-runner-registry / wrangler.toml
- an API request/response field, status code, auth lane, or cache behavior that differs from the route/handler (only for hand-written prose, not the generated catalogue)
- a described conditional behavior ("when X, returns/does Y") that the code does not implement
- a claim that a function/symbol/module does Z when it actually does something else

METHOD:
1. Read your assigned doc fully.
2. Use the source hints, then Grep/Glob/Read (and 'rg' via Bash) to locate the AUTHORITATIVE code for each concrete claim. shared/lib and worker/src are runtime truth; shared/data is data truth.
3. Only flag a claim when you have OPENED the code and it clearly contradicts the doc. Quote file:line as evidence.
4. Set classification: doc-wrong (code is right, doc is stale/incorrect) | code-wrong (doc describes intended behavior, code looks buggy/divergent) | ambiguous.
5. Set recentlyChanged:true when the contradicting code is in the CHANGED CONTEXT area (last 24h) — these are the highest-value findings since the docs may not have caught up to today's code.
6. Be generous about surfacing CANDIDATES with honest confidence — a later skeptic pass will reject weak ones. But never fabricate: no evidence => no finding.
7. Ignore editorial rationale, aspirational/roadmap prose, historical narrative, and design taste. Verify facts about current code only.`

function buildVerifyPrompt(item, changedContext) {
  const hints = item.sourceHints && item.sourceHints.length
    ? `Source hints (owning code): ${item.sourceHints.join(', ')}`
    : 'No source hints — Grep/Glob to find the owning code yourself.'
  const depthNote = item.depth === 'light'
    ? `DEPTH = LIGHT. This is a timeline/version-history or generated map. Do NOT verify historical entries (immutable record). Verify ONLY: (a) the "current"/"latest" version's described formula/behavior matches code, and (b) any "as of today / currently" claims. Sample a few representative entries; skip the rest. NOTE: the latest timeline entry may describe TODAY's change (see CHANGED CONTEXT) — verify it carefully against the new code.`
    : `DEPTH = DEEP. Verify every concrete code-checkable claim in the doc.`
  const noteBlock = item.note ? `\nDOC-SPECIFIC NOTE:\n${item.note}\n` : ''
  return `You are verifying ONE Pharos documentation file against the ACTUAL code. Do not trust the prose — prove each factual claim against the implementation.

DOC: ${item.path}  (category: ${item.category}, ${item.lines} lines)
${hints}
${noteBlock}
${depthNote}

CHANGED CONTEXT — code that changed in the last ~24h (since the previous audit). If your doc covers any of these areas, the doc is the MOST likely to have drifted; scrutinise these claims hardest and set recentlyChanged:true on any discrepancy here:
${changedContext}

${VERIFY_RULES}

${OUT_OF_SCOPE}

Working dir is the repo root. Return findings for ${item.path} only. If the doc is fully accurate, return docAccurate:true with findings:[]. No prose outside the structured output — your structured result IS the deliverable.`
}

function buildAdjudicatePrompt(item, findings) {
  return `You are an ADVERSARIAL skeptic adjudicating doc-vs-code discrepancy candidates for ONE doc. A first-pass agent flagged these; many will be wrong, over-eager, or based on misreading the code. Your job is to independently re-open the cited code and the doc and decide the truth.

DOC: ${item.path}

CANDIDATE FINDINGS (JSON):
${JSON.stringify(findings, null, 2)}

For EACH candidate:
- Open the doc line and the cited code yourself (Read/Grep). Do not trust the candidate's quotes — verify them.
- Default to REJECTED. Only CONFIRM when the current code clearly contradicts the doc, or REVISE when there is a real but mis-stated discrepancy (then give the corrected description + fix).
- Common reasons to REJECT: the doc is a deliberate simplification that is still true; the candidate misread the code; the claim is CI-guarded (see below); the "code" cited is a test/mock/fixture not runtime; the doc describes a different layer than the code cited; the value actually matches; the flagged text is a recorded live-snapshot measurement or a verbatim external quote (not a Pharos-code claim).
- If the doc is RIGHT and the CODE looks buggy/divergent, set finalClassification=code-wrong (we will NOT edit code from this workflow — we flag it).
- Preserve the recentlyChanged flag when you CONFIRM/REVISE a finding whose code is in the last-24h change set.
- adjudicatedDocFix: the exact replacement wording (or DELETE). Make it minimal, surgical, and matching the doc's existing style.

${OUT_OF_SCOPE}

Return one adjudicated entry per candidate (same docLine). Structured output only.`
}

// ===========================================================================
phase('Load')
const MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          lines: { type: 'integer' },
          category: { type: 'string' },
          sourceHints: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['path', 'category'],
      },
    },
  },
  required: ['docs'],
}

const loaded = await agent(
  `Read the file agents/doc-verify/manifest.json (repo root). It is a JSON ARRAY of objects, each with {path, lines, category, sourceHints, and sometimes note}. Return it verbatim as {docs:[...]} preserving every field including note. Do not modify, filter, or reorder. Structured output only.`,
  { label: 'load-manifest', phase: 'Load', schema: MANIFEST_SCHEMA, model: 'haiku' },
)

if (!loaded || !loaded.docs || !loaded.docs.length) {
  throw new Error('manifest load failed')
}

const date = (args && args.date) || 'today'
const changedContext = (args && args.changedContext) || 'No specific change context provided — verify all claims at normal rigor.'
const hotDocs = new Set((args && args.hotDocs) || [])

// Assign depth from category; skip the CI-current generated API reference entirely.
const items = loaded.docs
  .map((d) => {
    let depth = 'deep'
    if (d.category === 'timeline-archive' || d.path.endsWith('agent-code-map.md')) depth = 'light'
    if (d.path.endsWith('api-reference.md')) depth = 'skip'
    return { ...d, depth, hot: hotDocs.has(d.path) }
  })
  .filter((d) => d.depth !== 'skip')

log(`Loaded ${loaded.docs.length} docs; verifying ${items.length} (api-reference.md skipped). deep=${items.filter((i) => i.depth === 'deep').length} light=${items.filter((i) => i.depth === 'light').length} hot=${items.filter((i) => i.hot).length} (opus-verified)`)

// ===========================================================================
// Pipeline: verify (opus for hot docs / sonnet otherwise) -> adjudicate (opus). No barrier between docs.
const perDoc = await pipeline(
  items,
  (item) => agent(buildVerifyPrompt(item, changedContext), {
    label: `verify:${item.path.replace('docs/', '')}`,
    phase: 'Verify',
    schema: FINDINGS_SCHEMA,
    model: item.hot ? 'opus' : 'sonnet',
  }),
  (verifyResult, item) => {
    const findings = (verifyResult && verifyResult.findings) || []
    if (!findings.length) return { doc: item.path, adjudicated: [] }
    return agent(buildAdjudicatePrompt(item, findings), {
      label: `adjudicate:${item.path.replace('docs/', '')}`,
      phase: 'Adjudicate',
      schema: ADJUDICATION_SCHEMA,
      model: 'opus',
    })
  },
)

// Aggregate confirmed/revised findings (plain JS — needs all docs together).
const confirmed = []
for (const r of perDoc) {
  if (!r || !r.adjudicated) continue
  for (const a of r.adjudicated) {
    if (a.verdict === 'CONFIRMED' || a.verdict === 'REVISED') {
      confirmed.push({ doc: r.doc, ...a })
    }
  }
}
const recentCount = confirmed.filter((c) => c.recentlyChanged).length
log(`Adjudication complete: ${confirmed.length} confirmed/revised findings across ${new Set(confirmed.map((c) => c.doc)).size} docs (${recentCount} in last-24h-changed code)`)

// ===========================================================================
phase('Synthesize')
const reportPath = `agents/doc-verify/report-${date}.md`
const findingsPath = `agents/doc-verify/findings.json`
const datedFindingsPath = `agents/doc-verify/findings-${date}.json`
const synth = await agent(
  `You are the synthesis stage of a change-aware /docs-vs-code audit for the Pharos dashboard (run date: ${date}). The previous full audit was ~24h ago and its fixes were applied; this run re-verifies the whole corpus with extra scrutiny on code that changed in the last 24h. Below are all CONFIRMED/REVISED doc-vs-code discrepancies after an adversarial adjudication pass.

CONFIRMED FINDINGS (JSON):
${JSON.stringify(confirmed, null, 2)}

Do the following:
1. Dedupe near-identical findings (same doc + same root claim).
2. Partition each finding into:
   - AUTO-FIXABLE: finalClassification == doc-wrong AND confidence >= 0.7 AND adjudicatedDocFix is a concrete text replacement (not "investigate"). Safe to apply as doc edits.
   - NEEDS-DECISION: finalClassification == code-wrong (possible code bug — flag, do NOT auto-edit code), or ambiguous, or confidence < 0.7, or fix is non-mechanical.
3. Write a human report to ${reportPath} with: an executive summary (counts by severity, by partition, and how many are in last-24h-changed code), a clearly-marked "RECENTLY CHANGED (last 24h)" section FIRST listing findings where recentlyChanged==true (these are today's drift), then a "NEEDS-DECISION" section, then a per-doc section for the remaining auto-fixable findings (docLine, what doc says, what code does, codeEvidence, severity, the fix, partition).
4. Write the machine-readable array to ${findingsPath} (consumed by the remediation workflow) AND an identical copy to ${datedFindingsPath}, each finding annotated with a "partition" field ("auto-fixable" | "needs-decision") and preserving "recentlyChanged".

Use the Write tool for all three files. Then return the structured summary (counts incl. recentlyChangedCount + up to 14 headline one-liners of the most important confirmed issues, putting recently-changed ones first). reportPath=${reportPath}, findingsJsonPath=${findingsPath}.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'opus' },
)

return { ...synth, confirmedRaw: confirmed.length, recentlyChangedRaw: recentCount, docsVerified: items.length }
