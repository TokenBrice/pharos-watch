export const meta = {
  name: 'compliance-research',
  description: 'Broad MiCA + GENIUS compliance data pass for tracked stablecoins: landscape sweep, per-coin research, independent adversarial verify, and a reconciled corrections manifest (safe-to-auto-apply vs flagged) plus high-confidence gap proposals. Editorial data only — the orchestrator applies the manifest deterministically.',
  phases: [
    { title: 'Landscape', detail: 'GENIUS rulemaking + EU register/delisting sweep -> shared context for every per-coin agent' },
    { title: 'Discover gaps', detail: 'two agents shortlist prominent in-scope coins missing a regime profile' },
    { title: 'Research', detail: 'one agent per coin: re-verify/refresh genius + mica vs live regulator sources (sonnet)' },
    { title: 'Verify', detail: 'independent adversarial verifier per coin: reconcile, gate safe-to-auto-apply, flag consequential calls (sonnet)' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs (passed via Workflow args; scripts have no filesystem access)
// ---------------------------------------------------------------------------
const DATE = args && args.date
const AUDIT_COINS = (args && args.auditCoins) || []
const GENIUS_GAP_POOL_PATH = (args && args.geniusGapPoolPath) || null
const MICA_GAP_POOL_PATH = (args && args.micaGapPoolPath) || null

if (!/^20\d\d-\d\d-\d\d$/.test(DATE || '')) {
  throw new Error('args.date must be the current ISO date')
}
if (AUDIT_COINS.length === 0) {
  log('No auditCoins supplied in args — nothing to research. Pass args.auditCoins.')
}

// ---------------------------------------------------------------------------
// Keep volatile schema and regime state in their owning source files. Agents
// read those files during each pass instead of relying on workflow snapshots.
// ---------------------------------------------------------------------------

const GENIUS_RULES = 'Read shared/types/stablecoin-meta-schemas.ts, shared/lib/compliance-regime-state.ts, and docs/genius-tracker.md before evaluating GENIUS fields. Those files own enums, cross-field rules, dates, and regime status; never use a remembered snapshot.'

const MICA_RULES = 'Read shared/types/stablecoin-meta-schemas.ts and docs/mica-tracker.md before evaluating MiCA fields. Those files own enums, cross-field rules, authorization criteria, and transition status; never use a remembered snapshot.'

const SOURCING = [
  'SOURCING (descending authority). GENIUS authorization: Federal Register > federal regulators (OCC/Federal Reserve/FDIC/NCUA/FinCEN/OFAC/Treasury) > state regulators > issuer filings > issuer disclosures > auditor reports > news (never alone for an official status).',
  'MiCA: ESMA register > EBA EMT/ART issuer registers (+EBA significant list) > national NCA registers (ACPR REGAFI, BaFin, DNB/AFM, MFSA, CBI, Bank of Lithuania) > issuer disclosures > EU venue delisting/restriction notices (evidence for non-compliant).',
  'Map token -> legal issuer entity -> public posture/register. Confirm the entity is THIS token issuer, not a same-name affiliate. Use web search/fetch (load via ToolSearch "select:WebSearch,WebFetch" if needed; fall back to agent-browser on 403). Record access dates.',
].join('\n')

const CONSERVATISM = [
  'When uncertain between two statuses, pick the MORE CONSERVATIVE one and say why in notes (e.g. issuer-announced-intent over official-application-pending; no-public-authorization-found over issuer-announced-intent; mica non-compliant over transitional; pending over authorized).',
  'NEVER fabricate an authorization/approval. Leave a regime undefined (assessed=false) for coins genuinely out of EU/US scope or in the un-assessable DeFi/wrapper/fund long tail — "not assessed" (no row) is a valid, deliberate state and differs from an explicit out-of-scope/not-applicable assessment.',
  'This is an informational, sourced tracking surface, NOT legal advice.',
].join('\n')

// ---------------------------------------------------------------------------
// Structured output schemas. Proposed/final compliance objects are returned as
// JSON STRINGS (proposedJson / finalJson) so the freeform regime object is not
// fought by JSON-schema rigidity; the orchestrator parses + validates them via
// the real Zod (check:stablecoin-data) after a deterministic merge.
// ---------------------------------------------------------------------------

const REGIME_PROPOSAL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assessed: { type: 'boolean', description: 'true if this regime applies and was researched' },
    changeKind: { type: 'string', enum: ['no-change', 'correct', 'add-new-row', 'remove-row', 'unable-to-verify'] },
    consequential: { type: 'boolean', description: 'true if change is a new/upgraded authorization claim, status escalation, removal, or downgrade of an existing strong claim' },
    consequentialReason: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    summary: { type: 'string', description: 'one-line: current vs proposed and why' },
    proposedJson: { type: 'string', description: 'FULL schema-valid regime object as compact JSON text; "" if no-change/remove/unable-to-verify' },
    sources: { type: 'array', items: { type: 'string' }, description: 'source URLs actually consulted with what each showed' },
  },
  required: ['assessed', 'changeKind', 'consequential', 'confidence', 'summary', 'proposedJson'],
}

const RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    mica: REGIME_PROPOSAL,
    genius: REGIME_PROPOSAL,
    notes: { type: 'string' },
  },
  required: ['id', 'mica', 'genius'],
}

const REGIME_VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['confirm-no-change', 'apply-correction', 'flag-for-approval', 'reject-proposal', 'unable-to-verify', 'not-applicable'] },
    safeToAutoApply: { type: 'boolean' },
    isNewRow: { type: 'boolean' },
    finalJson: { type: 'string', description: 'schema-valid FINAL regime object as compact JSON text to write; "" if nothing should be written' },
    changeSummary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'safeToAutoApply', 'isNewRow', 'finalJson', 'changeSummary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    mica: REGIME_VERDICT,
    genius: REGIME_VERDICT,
    flags: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          regime: { type: 'string', enum: ['mica', 'genius'] },
          summary: { type: 'string' },
          action: { type: 'string', enum: ['needs-approval', 'needs-more-research'] },
        },
        required: ['regime', 'summary', 'action'],
      },
    },
    overallConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['id', 'mica', 'genius', 'flags'],
}

const LANDSCAPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    regimeStateRecommendation: { type: 'string', description: 'GENIUS only: recommended change to GENIUS_REGIME_STATE in shared/lib/compliance-regime-state.ts, or "no change"' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'findings'],
}

const GAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    regime: { type: 'string', enum: ['mica', 'genius'] },
    shortlist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          symbol: { type: 'string' },
          reason: { type: 'string', description: 'why this is a prominent, in-scope, high-confidence gap worth a row' },
        },
        required: ['id', 'reason'],
      },
    },
    rejectedNote: { type: 'string', description: 'one line on what was deliberately left out and why (e.g. DeFi/wrapper/fund long tail)' },
  },
  required: ['regime', 'shortlist'],
}

// ===========================================================================
// PHASE 1 — Landscape (barrier: every per-coin agent needs this shared context)
// ===========================================================================
phase('Landscape')

const landscapeProbes = [
  {
    label: 'landscape:genius-rulemaking',
    prompt: [
      `Today is ${DATE}. Research the CURRENT status of U.S. GENIUS Act rulemaking and any payment-stablecoin issuer authorizations, as of today.`,
      'Read shared/lib/compliance-regime-state.ts and docs/genius-tracker.md before searching so checked runtime state, not this workflow, owns dates and rulemaking phase.',
      'Determine: (a) has any PRIMARY-regulator FINAL rule been issued since then, or has the phase moved toward "final-rules-issued"/"effective"? (b) has the effective date changed? (c) have ANY issuers received a permitted-payment-stablecoin-issuer (PPSI) approval or state-qualified approval, or filed a publicly-visible official application? Name them if so with regulator-grade sources. (d) any notable GENIUS enforcement actions?',
      'Use authoritative sources only (Federal Register, OCC/Fed/FDIC/NCUA/FinCEN/OFAC/Treasury). In regimeStateRecommendation, state precisely whether GENIUS_REGIME_STATE needs updating and how, or "no change".',
      SOURCING,
    ].join('\n\n'),
    schema: LANDSCAPE_SCHEMA,
  },
  {
    label: 'landscape:mica-registers',
    prompt: [
      `Today is ${DATE}. Research the CURRENT EU MiCA authorization landscape for stablecoin (EMT/ART) issuers, as of today.`,
      'Summarize: which issuers/tokens are newly EMI- or credit-institution-authorized as EMT/ART since the review dates currently recorded in the tracker; any new EBA "significant" EMT/ART designations; any authorizations withdrawn. Focus on issuers relevant to the tracked stablecoin set.',
      'Cite ESMA register, EBA registers, and national NCA registers (ACPR REGAFI, BaFin, DNB/AFM, MFSA, CBI, Bank of Lithuania). regimeStateRecommendation: "no change" (MiCA has no central regime-state object).',
      SOURCING,
    ].join('\n\n'),
    schema: LANDSCAPE_SCHEMA,
  },
  {
    label: 'landscape:eu-venue-actions',
    prompt: [
      `Today is ${DATE}. Research CURRENT EU venue delisting/restriction actions and non-EUR/non-authorized stablecoin compliance posture in the EU, as of today.`,
      'Summarize the current state of EU exchange delistings/restrictions for major non-MiCA-authorized stablecoins (e.g. USDT and others), and any reversals. This is evidence for MiCA "non-compliant" vs "transitional" calls.',
      'Cite exchange notices and issuer statements. regimeStateRecommendation: "no change".',
      SOURCING,
    ].join('\n\n'),
    schema: LANDSCAPE_SCHEMA,
  },
]

const landscape = (await parallel(
  landscapeProbes.map((p) => () => agent(p.prompt, { label: p.label, phase: 'Landscape', schema: p.schema, model: 'sonnet' })),
)).filter(Boolean)

const LANDSCAPE_CONTEXT = [
  `SHARED LANDSCAPE CONTEXT (as of ${DATE}) — use to inform per-coin calls; still verify each token specifically:`,
  ...landscape.map((l, i) => `[${landscapeProbes[i]?.label || 'probe'}] ${l.headline}\n- ${(l.findings || []).join('\n- ')}`),
].join('\n\n')

const regimeStateNotes = landscape
  .map((l, i) => ({ probe: landscapeProbes[i]?.label, rec: l.regimeStateRecommendation, sources: l.sources }))
  .filter((x) => x.rec && x.rec.toLowerCase() !== 'no change')

// ===========================================================================
// PHASE 2 — Discover high-confidence gaps (barrier before merging into pipeline)
// ===========================================================================
phase('Discover gaps')

const gapAgents = []
if (GENIUS_GAP_POOL_PATH) {
  gapAgents.push(() => agent(
    [
      `Today is ${DATE}. Read the candidate pool file at ${GENIUS_GAP_POOL_PATH} (JSON array of active USD-pegged tracked coins with NO genius profile yet). From it, shortlist ONLY prominent, clearly-in-scope apparent PAYMENT stablecoins that genuinely warrant a GENIUS row and are currently missing one.`,
      'EXCLUDE the long tail: DeFi CDPs/over-collateralized units, yield/savings wrappers (sXXX, savings-*, staked-*), governance/algorithmic units, and tokenized funds/securities (these are out of scope — "not assessed" is the correct state for them). Bias HARD toward a short list (typically under ~10). It is fine to return an empty shortlist. Set regime="genius".',
      'For each pick, give a one-line reason it is a prominent in-scope payment stablecoin missing a row. Include its symbol if known.',
      GENIUS_RULES,
    ].join('\n\n'),
    { label: 'gaps:genius', phase: 'Discover gaps', schema: GAP_SCHEMA, model: 'sonnet' },
  ))
}
if (MICA_GAP_POOL_PATH) {
  gapAgents.push(() => agent(
    [
      `Today is ${DATE}. Read the candidate pool file at ${MICA_GAP_POOL_PATH} (JSON array of active tracked coins with NO mica profile but an EU signal). From it, shortlist ONLY coins that genuinely warrant a MiCA row and are currently missing one — chiefly EUR-pegged payment stablecoins offered/traded in the EU, plus prominent EU-issuer coins.`,
      'EXCLUDE coins that are clearly EU financial instruments / fund shares (MiFID instruments are out of MiCA EMT/ART scope) unless a prominent confusable case, and EXCLUDE non-EU coins swept in only by a charter keyword. Bias toward a short, defensible list. Empty is acceptable. Set regime="mica".',
      'For each pick, give a one-line reason. Include its symbol if known.',
      MICA_RULES,
    ].join('\n\n'),
    { label: 'gaps:mica', phase: 'Discover gaps', schema: GAP_SCHEMA, model: 'sonnet' },
  ))
}

// Normalize audit coins (compact args may carry only {id, regimes}). The gap
// agents (gapAgents thunks, above) are NOT executed here — they run concurrently
// with the audit below so they never block the per-coin pipeline.
const auditItems = AUDIT_COINS.map((c) => ({
  id: c.id,
  symbol: c.symbol || c.id,
  name: c.name || c.id,
  status: c.status || 'active',
  peg: c.peg,
  regimes: c.regimes || [],
  file: c.file || `shared/data/stablecoins/coins/${c.id}.json`,
  isGap: false,
}))
const auditById = new Map(auditItems.map((c) => [c.id, c]))

// ===========================================================================
// PHASE 3+4 — Research -> adversarial Verify. The audit pipeline starts
// immediately and runs CONCURRENTLY with gap discovery (no barrier between
// them); both share the per-workflow concurrency cap so all slots stay full.
// ===========================================================================

function researchPrompt(coin) {
  const regimes = coin.regimes && coin.regimes.length ? coin.regimes : ['genius', 'mica']
  const gapLine = coin.isGap
    ? `This coin currently has NO row for: ${regimes.join(', ')}. It was shortlisted as a possible high-confidence GAP. Reasons: ${JSON.stringify(coin.gapReasons || {})}. Decide whether a row is genuinely warranted; if not, set assessed=false / changeKind="no-change" for that regime. Any new row is changeKind="add-new-row" and consequential=true.`
    : `This coin currently HAS data for: ${regimes.join(', ')}. Re-verify and refresh it against live sources; correct errors; tighten precision; add/fix source references. Read reviewedAt from the current object instead of assuming a shared review date.`
  return [
    `Today is ${DATE}. You are auditing the compliance metadata for the tracked stablecoin "${coin.name}" (${coin.symbol}), id="${coin.id}", peg=${coin.peg}, lifecycle status=${coin.status}.`,
    `STEP 1: Read the per-coin JSON at ${coin.file} to see current jurisdiction, genius, and mica blocks. Also Read docs/genius-tracker.md and docs/mica-tracker.md if you need the full criteria.`,
    `STEP 2: Assess these regimes: ${regimes.join(', ')}. ${gapLine}`,
    'STEP 3: For EACH regime, research the issuer against authoritative sources and decide: no-change (current data is correct & sourced), correct (refine fields/sources/enums), add-new-row (gap, warranted), remove-row (current row is wrong/unwarranted), or unable-to-verify (sources unreachable / inconclusive — make NO change, explain).',
    'OUTPUT per regime: set assessed (does the regime apply?), changeKind, consequential (true for new/upgraded authorization claims, status escalations, removals, or downgrades of an existing strong claim), confidence, a one-line summary (current vs proposed + why), proposedJson = the FULL schema-valid regime object as compact JSON text (only when changeKind is correct/add-new-row; otherwise ""), and sources (URLs consulted + what each showed).',
    'If proposing a write, set reviewer="Pharos compliance research" and reviewedAt="' + DATE + '" inside the genius object (the mica object has no reviewer/date fields). Preserve still-correct existing fields; do not drop good data.',
    GENIUS_RULES,
    MICA_RULES,
    SOURCING,
    CONSERVATISM,
    LANDSCAPE_CONTEXT,
  ].join('\n\n')
}

function verifyPrompt(coin, research) {
  return [
    `Today is ${DATE}. You are the INDEPENDENT ADVERSARIAL VERIFIER for the compliance audit of "${coin.name}" (${coin.symbol}), id="${coin.id}". Your job is to be skeptical and protect against fabricated or overstated regulatory claims.`,
    `STEP 1: Read the current per-coin JSON at ${coin.file} (current genius/mica/jurisdiction).`,
    'STEP 2: Here is the researcher\'s proposal (JSON):\n' + JSON.stringify(research),
    'STEP 3: For EACH regime, independently check the proposal. Re-verify the HIGHEST-STAKES claims against primary sources yourself (especially any authorization/approval/authorized status and any new row). Confirm every reference URL resolves and names THIS token\'s issuer (not a same-name affiliate). Confirm the proposed object satisfies ALL Zod cross-field rules and enum constraints. Default to REJECT for any unsupported upgrade.',
    'STEP 4: Produce a verdict per regime: confirm-no-change | apply-correction | flag-for-approval | reject-proposal | unable-to-verify | not-applicable. Set finalJson = the FINAL schema-valid regime object to write (compact JSON text), or "" if nothing should be written.',
    'safeToAutoApply = TRUE only if ALL hold: (a) finalJson is schema-valid; (b) it edits an EXISTING row (isNewRow=false); (c) it does NOT escalate to a stronger authorization claim than currently present (mica authorized/pending; genius ppsi-approved/state-qualified/official-application-pending) unless that claim was ALREADY present and equally/better sourced; (d) it does NOT remove a row or downgrade an existing strong claim; (e) changes are limited to refined/added/corrected references, refined descriptive fields (issuerEntity, licensingRegulator, notes, applicabilityBasis, disclosure flags backed by a URL), more-conservative enum corrections, or date refresh. Anything else -> safeToAutoApply=FALSE and add a flag with action.',
    'isNewRow = true when the final object would create a row that does not currently exist (gap-fill) — these are NEVER safeToAutoApply; flag them with action="needs-approval".',
    'For confirm-no-change set finalJson="" and safeToAutoApply=false. For unable-to-verify set finalJson="" and add a flag action="needs-more-research".',
    'changeSummary: concise human-readable current->final for the reviewer. issues: concrete problems found in the proposal.',
    GENIUS_RULES,
    MICA_RULES,
    SOURCING,
    CONSERVATISM,
  ].join('\n\n')
}

const researchStage = (coin) => agent(researchPrompt(coin), { label: `research:${coin.id}`, phase: 'Research', schema: RESEARCH_SCHEMA, model: 'sonnet' })
const verifyStage = (research, coin) => agent(verifyPrompt(coin, research), { label: `verify:${coin.id}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' })

// Start the per-coin audit pipeline now so it can fill the available concurrency slots.
phase('Research')
const auditPromise = pipeline(auditItems, researchStage, verifyStage)

// Gap discovery + gap pipeline run concurrently (independent of the audit).
const gapPromise = (async () => {
  const gapResults = (await parallel(gapAgents)).filter(Boolean)
  const items = []
  for (const g of gapResults) {
    for (const pick of g.shortlist || []) {
      let item = items.find((it) => it.id === pick.id)
      if (!item) {
        item = {
          id: pick.id,
          symbol: pick.symbol || pick.id,
          name: pick.id,
          status: 'active',
          peg: undefined,
          file: `shared/data/stablecoins/coins/${pick.id}.json`,
          regimes: [],
          isGap: true,
          gapReasons: {},
        }
        items.push(item)
      }
      if (!item.regimes.includes(g.regime)) item.regimes.push(g.regime)
      item.gapReasons[g.regime] = pick.reason
    }
  }
  log(`Gap rows proposed: ${items.length} (genius+mica shortlists).`)
  const gv = items.length ? (await pipeline(items, researchStage, verifyStage)).filter(Boolean) : []
  return { gapItems: items, gapVerify: gv }
})()

log(`Audit: ${auditItems.length} coins researching now (concurrency cap 14); gap discovery running concurrently.`)

const [auditVerify, gap] = await Promise.all([auditPromise, gapPromise])
const gapItems = gap.gapItems
const verifyResults = [...auditVerify.filter(Boolean), ...gap.gapVerify]

// ===========================================================================
// Assemble manifest from verify verdicts.
// ===========================================================================
const changes = [] // writable / proposed regime objects
const flags = []
const summaryRows = []

for (const v of verifyResults) {
  const coin = auditById.get(v.id) || gapItems.find((g) => g.id === v.id) || { id: v.id }
  for (const regime of ['mica', 'genius']) {
    const rv = v[regime]
    if (!rv) continue
    if (rv.finalJson && rv.finalJson.trim() !== '') {
      changes.push({
        id: v.id,
        symbol: coin.symbol,
        regime,
        verdict: rv.verdict,
        safeToAutoApply: !!rv.safeToAutoApply && !rv.isNewRow,
        isNewRow: !!rv.isNewRow,
        changeSummary: rv.changeSummary,
        finalJson: rv.finalJson,
      })
    }
  }
  for (const f of v.flags || []) flags.push({ id: v.id, symbol: coin.symbol, ...f })
  summaryRows.push({
    id: v.id,
    symbol: coin.symbol,
    isGap: !!coin.isGap,
    mica: v.mica?.verdict,
    genius: v.genius?.verdict,
    confidence: v.overallConfidence,
  })
}

const safeChanges = changes.filter((c) => c.safeToAutoApply)
const flaggedChanges = changes.filter((c) => !c.safeToAutoApply)

log(`Done. ${verifyResults.length} coins verified. Safe auto-applicable: ${safeChanges.length}. Flagged (needs approval): ${flaggedChanges.length}. Flags: ${flags.length}. Gap rows: ${gapItems.length}. Regime-state recs: ${regimeStateNotes.length}.`)

return {
  date: DATE,
  counts: {
    coinsVerified: verifyResults.length,
    safeAutoApply: safeChanges.length,
    flagged: flaggedChanges.length,
    gapRowsProposed: gapItems.length,
  },
  safeChanges,
  flaggedChanges,
  flags,
  gapItems,
  regimeStateNotes,
  landscape: landscape.map((l, i) => ({ probe: landscapeProbes[i]?.label, headline: l.headline, findings: l.findings, regimeStateRecommendation: l.regimeStateRecommendation, sources: l.sources })),
  summaryRows,
}
