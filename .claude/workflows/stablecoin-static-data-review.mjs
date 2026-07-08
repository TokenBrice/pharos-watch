export const meta = {
  name: 'stablecoin-static-data-review',
  description: 'Review every tracked stablecoin JSON entry for factual + internal-consistency errors (read-only). Sonnet discover net over coin chunks, Opus adversarial skeptic per flagged coin, deterministic structured return (no LLM persist step).',
  phases: [
    { title: 'Enumerate' },
    { title: 'Discover', detail: 'sonnet net over ~5-coin chunks' },
    { title: 'Verify', detail: 'Opus skeptic per flagged coin' },
  ],
}

// ---------------------------------------------------------------------------
// Fixed corpus locations (this run targets the 409 tracked coin JSONs).
// ---------------------------------------------------------------------------
const BASE = '/home/ahirice/Documents/git/pharos-watch/shared/data/stablecoins/coins'
const RES = '/home/ahirice/Documents/git/pharos-watch/shared/data/stablecoins/domains/reserves'
const CORPUS_FILE =
  '/tmp/claude-1000/-home-ahirice-Documents-git-pharos-watch/f5cd37bc-3ee9-4332-b5dc-b381ed0834dd/scratchpad/coin-corpus.json'
const TODAY = '2026-07-07'
const CHUNK = 5

const CATEGORIES = [
  'identity',
  'mechanism',
  'flags',
  'mint-authority',
  'chains-contracts',
  'identifiers',
  'links',
  'jurisdiction',
  'mica',
  'genius',
  'proof-of-reserves',
  'reserves',
  'issuance-date',
  'lifecycle-status',
  'resilience',
  'other',
]

// Shared review rubric — kept identical between the discover net and the
// adversarial verify pass so both reason over the same scope.
const RUBRIC = `You are auditing the STATIC metadata of tracked stablecoins on Pharos (a stablecoin analytics dashboard). Today is ${TODAY}.

Only FACTUAL, verifiable metadata is in scope. For each field, decide whether the stored value is factually wrong, internally contradictory, or stale.

IN SCOPE (flag concrete, sourced problems):
- identity: name, symbol (on-chain casing), oneLiner, flags.pegCurrency vs the asset it actually tracks.
- mechanism: collateral prose, pegMechanism prose, mechanismArchetype (must match documented design).
- flags: backing, governance, yieldBearing, rwa, navToken — check internal consistency (e.g. backing='rwa-backed' but rwa=false; yieldConfig present but yieldBearing=false; base vs wrapper yield convention).
- mint-authority: only concrete factual errors — malformed/short EVM addresses (must be 40 hex chars after 0x), threshold/signerCount contradicted by a cited source. Do NOT re-audit narrative/provenance prose.
- chains-contracts: missing chain deployments that are officially announced+live; wrong/typo contract addresses; wrong decimals. Verify against official docs / block explorers / rwa.xyz when possible.
- identifiers: geckoId, llamaId, cmcSlug, pythFeedId, protocolSlug resolve to THIS asset.
- links: label matches the URL target; URL is the correct official domain (not a dead/wrong/placeholder link).
- jurisdiction: country, regulator, license accuracy.
- mica / genius: only clear factual status errors (authorization status, entity, domicile). Do NOT re-litigate nuanced compliance judgment.
- proof-of-reserves: provider, cadence, attestor, url accuracy/liveness.
- reserves: composition array vs current disclosed reserves and vs the coin's own collateral/oneLiner prose (flag drift and internal contradictions).
- issuance-date: launchDate / announcedDate / expectedLaunchDate accuracy; expectedLaunchDate in the past for a still-pre-launch coin (stale); launchDate in the future for an active coin.
- lifecycle-status: status (active/frozen/pre-launch), frozenAt, obituary facts, launchPhase correctness vs reality.
- resilience: deploymentModel / bridgeRouteRisk.tier / custodyModel / chainTier / collateralQuality only when the FACTUAL basis is wrong (e.g. labelled native-multichain but actually a third-party bridge). Note these feed scoring.

STRONGLY PREFER internal-consistency checks (no web needed, high signal): field-vs-field contradictions inside the same file (oneLiner vs collateral vs reserves; flags vs yieldConfig; collateral currency vs pegCurrency; address length anomalies; archetype vs pegMechanism).

OUT OF SCOPE — never flag: any numeric score or scoring weight, oracleRisk scoring, dependencies weights, reserves risk-tier labels (very-low/low/etc are subjective), tags, featuredContent, notices wording, blacklistabilityReview prose, mintAuthority evidence prose, subjective yield APR figures, stylistic wording preferences.

Be CONSERVATIVE. Default assumption: the stored value is correct. Only surface a finding when you have a concrete reason (a citation or an in-file contradiction). Prefer precision over recall — false positives are costly.`

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const DISCOVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['coinId', 'field', 'category', 'confidence', 'currentValue', 'suggestedCorrection', 'evidence'],
        properties: {
          coinId: { type: 'string' },
          field: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          currentValue: { type: 'string' },
          suggestedCorrection: { type: 'string' },
          evidence: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verified'],
  properties: {
    verified: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['coinId', 'field', 'category', 'confidence', 'verdict', 'currentValue', 'suggestedCorrection', 'evidence'],
        properties: {
          coinId: { type: 'string' },
          field: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          verdict: { type: 'string', enum: ['confirmed-error', 'uncertain', 'false-positive'] },
          currentValue: { type: 'string' },
          suggestedCorrection: { type: 'string' },
          finalSuggestion: { type: 'string' },
          evidence: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function discoverPrompt(ids, sidecarSet) {
  const list = ids
    .map((id) => `- ${id}  →  ${BASE}/${id}.json${sidecarSet.has(id) ? `  (reserves sidecar: ${RES}/${id}.json)` : ''}`)
    .join('\n')
  return `${RUBRIC}

TASK: Review the following ${ids.length} stablecoin entries. Read each JSON file with the Read tool (and the reserves sidecar file when noted — for those coins the base file's reserves live in the sidecar). Use WebSearch / WebFetch when available to confirm external facts (official docs, block explorers, rwa.xyz, coingecko, defillama). When web is unavailable, still perform every internal-consistency check.

Coins to review:
${list}

Return every candidate correction as a finding. If a coin has no issues, include nothing for it. currentValue = the stored value verbatim (truncate very long prose to the relevant clause). suggestedCorrection = the concrete fix. evidence = why it is wrong, citing sources. Return {"findings":[...]} (empty array if the whole chunk is clean).`
}

function verifyPrompt(coinId, findings, isSidecar) {
  return `${RUBRIC}

You are an ADVERSARIAL SKEPTIC. A first-pass reviewer flagged the candidate corrections below for a single coin. Your default stance is that the STORED value is CORRECT and the flag is wrong; only confirm an error when independent evidence still shows the stored value is wrong.

Coin: ${coinId}
File: ${BASE}/${coinId}.json${isSidecar ? `\nReserves sidecar: ${RES}/${coinId}.json` : ''}

Read the file yourself (Read tool). Independently verify each candidate with WebSearch / WebFetch (official docs, explorers, rwa.xyz, coingecko, defillama) and in-file cross-checks. For each candidate return a verdict:
- "confirmed-error": you found sourced evidence the stored value is wrong.
- "uncertain": plausible but you could not conclusively resolve it (e.g. a source you could not fetch) — needs a human.
- "false-positive": the stored value is actually fine / the flag is mistaken.

Set finalSuggestion to your own corrected recommendation (may differ from the candidate). Keep evidence concise but cite concrete sources/URLs.

Candidate findings (JSON):
${JSON.stringify(findings)}

Return {"verified":[...]} with one entry per candidate.`
}

// ---------------------------------------------------------------------------
// Enumerate — deterministic corpus read via a tiny helper agent (cat the
// pre-computed corpus file; keeps enumeration reproducible on resume).
// ---------------------------------------------------------------------------
phase('Enumerate')
const enumRaw = await agent(
  `Run EXACTLY this one bash command and return ONLY its stdout verbatim, with no commentary and no code fences:\n\ncat ${CORPUS_FILE}`,
  { label: 'enumerate', phase: 'Enumerate', model: 'haiku' },
)
let corpus
try {
  const s = enumRaw.slice(enumRaw.indexOf('{'), enumRaw.lastIndexOf('}') + 1)
  corpus = JSON.parse(s)
} catch (e) {
  throw new Error(`Failed to parse corpus JSON from enumerate agent: ${String(e)}`)
}
const ids = corpus.ids || []
const sidecarSet = new Set(corpus.sidecarIds || [])
log(`corpus: ${ids.length} coins, ${sidecarSet.size} reserves sidecars, chunk=${CHUNK}`)
if (ids.length === 0) return { error: 'no coins enumerated' }

const chunks = chunk(ids, CHUNK)
log(`discover agents: ${chunks.length} (sonnet) → per-coin Opus verify`)

// ---------------------------------------------------------------------------
// Discover (sonnet, per chunk) → Verify (Opus skeptic, per flagged coin).
// Pipelined: a chunk's findings verify as soon as that chunk finishes, while
// later chunks are still discovering. Findings are partitioned by coin (each
// coin is in exactly one chunk) so no cross-chunk dedup barrier is needed.
// ---------------------------------------------------------------------------
phase('Discover')
const perChunk = await pipeline(
  chunks,
  (chunkIds, _orig, idx) =>
    agent(discoverPrompt(chunkIds, sidecarSet), {
      schema: DISCOVER_SCHEMA,
      model: 'sonnet',
      effort: 'high',
      agentType: 'general-purpose',
      label: `discover:${idx}`,
      phase: 'Discover',
    }),
  (disc, _chunkIds, idx) => {
    const findings = (disc && disc.findings) || []
    if (findings.length === 0) return []
    const byCoin = new Map()
    for (const f of findings) {
      if (!byCoin.has(f.coinId)) byCoin.set(f.coinId, [])
      byCoin.get(f.coinId).push(f)
    }
    return parallel(
      Array.from(byCoin.entries()).map(([coinId, coinFindings]) => () =>
        agent(verifyPrompt(coinId, coinFindings, sidecarSet.has(coinId)), {
          schema: VERIFY_SCHEMA,
          effort: 'high',
          agentType: 'general-purpose',
          label: `verify:${coinId}`,
          phase: 'Verify',
        }).then((v) => (v && v.verified) || []),
      ),
    ).then((arrs) => arrs.filter(Boolean).flat())
  },
)

// ---------------------------------------------------------------------------
// Aggregate (deterministic — no LLM persist step). The main loop writes the
// markdown from this structured return; journal.jsonl is the fallback.
// ---------------------------------------------------------------------------
const verified = perChunk.filter(Boolean).flat()
const chunksReturned = perChunk.filter((r) => r !== null).length
const rawCount = verified.length
const confirmed = verified.filter((f) => f.verdict === 'confirmed-error')
const uncertain = verified.filter((f) => f.verdict === 'uncertain')
const falsePositives = verified.filter((f) => f.verdict === 'false-positive')
const reported = verified.filter((f) => f.verdict === 'confirmed-error' || f.verdict === 'uncertain')

const byCategory = {}
for (const c of CATEGORIES) byCategory[c] = 0
for (const f of reported) byCategory[f.category] = (byCategory[f.category] || 0) + 1

return {
  summary: {
    date: TODAY,
    coinsChecked: ids.length,
    discoverAgents: chunks.length,
    chunksReturned,
    rawVerifiedRows: rawCount,
    confirmedErrors: confirmed.length,
    uncertain: uncertain.length,
    falsePositivesDropped: falsePositives.length,
    totalReported: reported.length,
    byCategory,
  },
  findings: reported,
}
