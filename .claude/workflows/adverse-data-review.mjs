export const meta = {
  name: 'adverse-data-review',
  description: 'Verify static metadata accuracy across all 407 tracked stablecoins; retain only high-confidence wrong values',
  phases: [
    { title: 'Discover', detail: 'sonnet readers flag suspected-wrong static fields per coin chunk' },
    { title: 'Verify', detail: 'adversarial Opus skeptic confirms or refutes each suspected error' },
  ],
}

// ---- inputs ----
const coinIds = Array.isArray(args) ? args : []
if (!coinIds.length) throw new Error('args must be a non-empty array of coin IDs')
const CHUNK = 5
const chunks = []
for (let i = 0; i < coinIds.length; i += CHUNK) chunks.push(coinIds.slice(i, i + CHUNK))
log(`${coinIds.length} coins → ${chunks.length} discover chunks (${CHUNK}/chunk)`)

// reserve sidecars that live outside coins/ (only these have a separate file)
const RESERVE_SIDECARS = new Set(['pyusd-paypal', 'usdc-circle', 'usde-ethena', 'usds-sky', 'usdt-tether'])

const CATEGORIES = [
  'identity', 'mechanism', 'flags', 'mint-authority', 'chains-contracts',
  'identifiers', 'mica', 'genius', 'jurisdiction', 'proof-of-reserves',
  'issuance-date', 'lifecycle', 'resilience', 'links', 'other',
]

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
        required: ['coinId', 'field', 'category', 'currentValue', 'suggestedCorrection', 'issue', 'confidence', 'evidence', 'needsExternal'],
        properties: {
          coinId: { type: 'string' },
          field: { type: 'string', description: 'dotted path to the wrong field, e.g. jurisdiction.regulator or contracts[2].address or launchDate' },
          category: { type: 'string', enum: CATEGORIES },
          currentValue: { type: 'string', description: 'the value currently in the file (stringified)' },
          suggestedCorrection: { type: 'string', description: 'the value you believe is correct, or "REMOVE" / "unknown" if you only know the current value is wrong' },
          issue: { type: 'string', description: 'one sentence: what is wrong' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'the sourced facts that contradict the current value, with URLs' },
          needsExternal: { type: 'boolean', description: 'true if you could not fetch the authoritative source and a human must check' },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isWrong', 'confidence', 'verdict', 'finalSuggestion', 'rationale', 'sources'],
  properties: {
    isWrong: { type: 'boolean', description: 'true ONLY if you found sourced evidence the current value is factually wrong' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high only when authoritative evidence directly and unambiguously contradicts the current value' },
    verdict: { type: 'string', enum: ['confirmed-error', 'uncertain', 'false-positive'] },
    finalSuggestion: { type: 'string', description: 'the corrected value you would apply, or "unknown" / "REMOVE"' },
    rationale: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
}

const NO_FLAG_RULES = `
DO NOT FLAG (these are not errors — flagging them is a false positive):
- Pharos scoring/calibration judgment fields: any *score*, resilience risk TIERS as such (chainTier, custodyModel tier label, collateralQuality tier, deploymentModel as a risk label, attestorTier, bridgeRouteRisk.tier/confidence, reserves[].risk). Their FACTUAL sub-claims ARE checkable (e.g. an attestor's NAME, an attestation CADENCE, a jurisdiction, a named bridge PROTOCOL), but not the chosen tier itself.
- circulating / supply / market-cap / price values — these are runtime, never stored statically here.
- A Hyperliquid-chain contract that is a 0x + 32 hex (16-byte) HyperCore tokenId — that is the correct format, not a malformed EVM address.
- reviewedAt / accessedAt / reviewer dates in 2026 — today is 2026-06-30; near-term dates are normal.
- launchDate being recent or future-ish — only flag if you have a sourced, clearly different real launch/issuance date.
- DefiLlama llamaId / detailProvider plumbing unless the asset is clearly mismatched to the wrong project.
- Stylistic wording of oneLiner/collateral/pegMechanism prose — only flag a FACTUAL claim that is wrong (wrong issuer, wrong collateral type, wrong peg, wrong mechanism), not phrasing.
- Schema validity / enum membership — CI already guards that.
`

function discoverPrompt(chunk) {
  const sidecarNote = chunk
    .filter((id) => RESERVE_SIDECARS.has(id))
    .map((id) => `  - ${id} also has a reserves sidecar at shared/data/stablecoins/domains/reserves/${id}.json`)
    .join('\n')
  return `You are auditing the factual accuracy of static metadata for tracked stablecoins in the Pharos dashboard. Today is 2026-06-30.

For EACH of these coins, read its JSON file at shared/data/stablecoins/coins/<id>.json:
${chunk.map((id) => `  - ${id}`).join('\n')}
${sidecarNote ? 'Reserve sidecars (read these too):\n' + sidecarNote + '\n' : ''}
Then verify, against authoritative external sources, the FACTUAL static fields. Use WebSearch and WebFetch (load them via ToolSearch if needed). Prioritise the issuer's official site/docs, the relevant block explorer, DefiLlama, and the named auditor/regulator register.

Check these factual fields per coin:
- Identity: name, symbol, flags.pegCurrency (does the asset actually peg to that currency?).
- Mechanism: flags.backing, flags.governance, flags.yieldBearing, mechanismArchetype, and FACTUAL claims in collateral / pegMechanism (issuer, collateral type, mint/redeem mechanism).
- Identifiers: geckoId (resolves to THIS asset on CoinGecko), llamaId/detailProvider sanity, pythFeedId plausibility.
- Chains & contracts: each contracts[].chain / address / decimals — does the address exist on that chain and correspond to this token? (Verify via explorer/DefiLlama; do not invent addresses.)
- Jurisdiction: country, regulator, license.
- Proof of reserves: proofOfReserves.provider (auditor name), type, cadence, url reachable & about this asset, attestorJurisdiction.
- Links: each links[].url — does it resolve and belong to THIS asset/issuer (not a different chain's frontend or a dead/wrong domain)?
- Lifecycle/status: any status/lifecycle/cemetery flag vs. reality (depegged/wound-down/active).
- Issuance/launch date: only if you have a sourced, clearly different date.
- Compliance (mica/genius) and mintAuthority: ONLY flag if a public, authoritative source clearly contradicts a concrete factual claim (e.g. wrong regulator, wrong authorization status with evidence). These already carry their own sourced provenance — do not re-litigate on-chain mint roles without a clear public contradiction.
${NO_FLAG_RULES}
Return ONLY suspected errors you can support with evidence. Skip fields that look correct. It is fine to return an empty findings array for a coin. Be precise about currentValue (copy it from the file) and cite URLs in evidence. Mark needsExternal=true if you could not reach the authoritative source.`
}

function verifyPrompt(f) {
  return `You are an adversarial fact-checker. Your DEFAULT assumption is that the current value in the Pharos database is CORRECT and the proposed correction is wrong. Only overturn that default if you independently find authoritative, sourced evidence that the current value is factually wrong. Today is 2026-06-30.

Coin: ${f.coinId}
File: shared/data/stablecoins/coins/${f.coinId}.json
Field: ${f.field}
Category: ${f.category}
Current value in DB: ${f.currentValue}
Proposed correction: ${f.suggestedCorrection}
Reported issue: ${f.issue}
Discoverer's evidence: ${f.evidence}

Independently verify using WebSearch/WebFetch (load via ToolSearch if needed) and by reading the coin file. Check the issuer's official source, the block explorer, DefiLlama, CoinGecko, or the named auditor/regulator — do not rely on the discoverer's evidence alone.

${NO_FLAG_RULES}

Decide:
- isWrong=true + verdict="confirmed-error" ONLY if authoritative evidence shows the current value is wrong. Set confidence="high" only when the evidence is authoritative and directly, unambiguously contradicts the current value.
- verdict="uncertain" if you cannot conclusively resolve it (e.g. source unreachable).
- isWrong=false + verdict="false-positive" if the current value is actually correct or defensible.
Provide finalSuggestion (the value you would apply, or "unknown"/"REMOVE"), a crisp rationale, and the source URLs you used.`
}

// ---- run: discover per chunk, then verify each finding from that chunk ----
const results = await pipeline(
  chunks,
  (chunk, _orig, idx) =>
    agent(discoverPrompt(chunk), {
      label: `discover:${idx}:${chunk[0]}`,
      phase: 'Discover',
      model: 'sonnet',
      effort: 'medium',
      schema: DISCOVER_SCHEMA,
    }),
  (disc, chunk, idx) => {
    const findings = (disc && Array.isArray(disc.findings) ? disc.findings : [])
      // keep only the discoverer's medium/high suspicions to spend verify budget well
      .filter((f) => f && f.confidence !== 'low')
    if (!findings.length) return []
    return parallel(
      findings.map((f) => () =>
        agent(verifyPrompt(f), {
          label: `verify:${f.coinId}:${f.field}`,
          phase: 'Verify',
          effort: 'high',
          schema: VERIFY_SCHEMA,
        }).then((v) => (v ? { ...f, ...v, sourceChunk: idx } : null))
      )
    )
  }
)

const all = results.flat().filter(Boolean)
const retained = all.filter((x) => x.isWrong === true && x.verdict === 'confirmed-error' && x.confidence === 'high')
const mediumConfirmed = all.filter((x) => x.isWrong === true && x.verdict === 'confirmed-error' && x.confidence !== 'high')
const uncertain = all.filter((x) => x.verdict === 'uncertain')
const falsePositives = all.filter((x) => x.verdict === 'false-positive')

const stats = {
  coinsChecked: coinIds.length,
  discoverChunks: chunks.length,
  verifiedFindings: all.length,
  retainedHighConfidence: retained.length,
  mediumConfirmed: mediumConfirmed.length,
  uncertain: uncertain.length,
  falsePositivesDropped: falsePositives.length,
}
log(`done: ${retained.length} high-confidence wrong / ${all.length} verified / ${falsePositives.length} dropped`)

return { stats, retained, mediumConfirmed, uncertain, all }
