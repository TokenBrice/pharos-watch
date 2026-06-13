export const meta = {
  name: 'code-health-broad',
  description: 'Broad repo-wide code-health review: fan-out finders → adversarial verify → cluster → write prioritized report',
  phases: [
    { title: 'Find', detail: '26 domain finders (sonnet) hunt simplification/dedup/maintainability opportunities' },
    { title: 'Verify', detail: 'per-domain Opus verifier adversarially confirms each finding, drops false positives' },
    { title: 'Cluster', detail: 'Opus synthesis: dedup cross-domain, prioritize, cross-ref scores report' },
    { title: 'Write', detail: 'Opus writer assembles /agents/code-health-report.md' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

const HARD_RULES = `
PROJECT HARD RULES (a recommendation that violates any of these is INVALID — do not propose it):
- Tailwind classes must be static strings; never construct class names dynamically.
- Classification labels/colors live ONLY in shared/lib/classification.ts.
- Worker code deliberately uses loose-equality null guards (\`x != null\`); this is INTENTIONAL — never "fix" to !==.
- Use getCirculatingRaw() from shared/lib/supply.ts; DefiLlama list \`circulating\` is already USD — never multiply list supply by price; never add manual/on-chain/CMC/DEX supply overrides.
- Shared runtime imports use @shared/lib/... and @shared/types...; avoid relative cross-boundary imports.
- shared/lib/ must stay runtime-neutral (no DOM, no Node-only, no Cloudflare-only APIs); targets ES2022.
- Methodology version constants/labels and changelog ownership are governed; do not casually rename.
- Match existing style. Prefer the smallest root-cause change. No speculative abstractions for single-use code.`

const SCORES_EXCLUSION = `
ALREADY-REVIEWED (DO NOT re-report — a separate audit "agents/scores-compute-code-health.md" covers these in depth):
the entire SCORE-COMPUTATION layer: shared/lib/report-card-*.ts, peg-score.ts, peg-rates.ts,
mint-authority-scoring.ts, redemption-backstop-scoring.ts, liquidity-score*.ts, report-card-core.ts,
shared/lib/chains/health*.ts, shared/lib/methodology-versions/**, shared/lib/depeg-resolver/**,
shared/lib/depeg-resolver-review/**, worker/src/lib/stability-index.ts, worker/src/lib/mint-burn-*.ts,
worker/src/lib/tape-projectors/**, worker/src/cron/compute-depeg-resolver-review.ts, show-your-work governance,
and the proposed shared/lib/math.ts roundScore/stats consolidation. If your slice CONSUMES one of these,
that's fine, but do NOT raise findings whose primary fix lives in those files. Cross-reference the existing
report by name instead.`

const CATEGORIES = `duplication | simplification | dead-code | readability | restructure | maintainability | type-safety | test-gap | naming | consistency | performance`

const OUTPUT_CONTRACT = `
OUTPUT CONTRACT (return ONLY the structured object — no prose, no file dumps):
- Return your TOP findings only, highest-leverage first. Aim for 6-12; quality over quantity. Skip nits with no real payoff.
- Each finding: problem <= 55 words, recommendation <= 55 words (concrete + behavior-preserving where possible), evidence <= 35 words (grep counts / duplicate site list / why it's true).
- "files" must cite real paths (and line ranges when you can) you actually opened.
- id format: "<domainKey>-<n>" e.g. "f-hooks-3".
- behaviorPreserving=true only if the change provably cannot alter runtime output.
- Favor: collapsing real duplication into a shared helper, deleting dead code, decomposing god-files,
  clarifying confusing control flow, naming magic numbers, tightening loose types. Avoid taste-only churn.`

function finderPrompt(d) {
  return `You are a senior engineer doing a focused CODE-HEALTH review of ONE slice of the Pharos stablecoin dashboard repo (cwd is the repo root). Goal: find concrete opportunities for SIMPLIFICATION, DEDUPLICATION, improved MAINTAINABILITY/READABILITY, and clarifying RESTRUCTURING.

YOUR SLICE: ${d.title}
SCOPE & WHERE TO LOOK:
${d.scope}

Categories to consider: ${CATEGORIES}

METHOD: Use Glob/Grep/Read/Bash to inspect your slice. Read the largest/most-central files in scope fully. Use grep to confirm a duplicated idiom's true call-count before claiming duplication. Stay STRICTLY within your slice — other agents cover other areas; do not wander.
${HARD_RULES}
${SCORES_EXCLUSION}
${OUTPUT_CONTRACT}`
}

function verifierPrompt(d, findings) {
  return `You are an ADVERSARIAL verifier. A first-pass reviewer produced the candidate code-health findings below for the slice "${d.title}". Your job is to REFUTE each one, then keep only what survives.

For EACH finding, open the cited files yourself and judge:
1. Is the problem REAL and accurately described? (wrong line refs, overstated counts, or "duplication" that is actually divergent/necessary → keep:false or correct it.)
2. Is the recommendation BEHAVIOR-PRESERVING and safe, or does it risk changing runtime output / violate a PROJECT HARD RULE?
3. Is it ALREADY handled — by an existing shared helper, an existing CI check (npm run check:* / lint rule), or the scores-compute audit? If so set alreadyCovered and keep:false (unless still actionable).
4. Recalibrate severity/effort/risk honestly. Demote speculative or taste-only items.

Default to skepticism: if you cannot confirm a finding by reading the code, drop it (keep:false) with a note. Correct any inaccurate file/line/count. For survivors, sharpen the recommendation into something an implementer can act on, and list any check:* commands that must run after the change.
${HARD_RULES}

CANDIDATE FINDINGS (JSON):
${JSON.stringify(findings)}

Return the structured verdict object. Include EVERY candidate id (with keep true/false). Return ONLY the structured object.`
}

const SCORES_DIGEST = `The companion audit agents/scores-compute-code-health.md already covers the scoring layer. Its cross-cutting themes (DO NOT duplicate — reference it instead): grade->rank table duplicated on 3 incompatible scales; hand-rolled median/percentile with one upper-middle bug; missing roundScore() helper (round-then-clamp inlined ~15x); inconsistent methodology-version export naming + changelog path drift; duplicated compact-USD formatting and isRecord/stringValue/numberValue guards; open-coded penalty/blend/band ladders; scattered scoring magic numbers; test-gaps on score constants.`

function clusterPrompt(kept) {
  return `You are the synthesis lead for a broad repo-wide code-health review of the Pharos dashboard. Below are the VERIFIED, kept findings (false positives already removed) from 26 code domains.

${SCORES_DIGEST}

Your job:
1. DEDUPLICATE: the same root issue often surfaces across domains (e.g. one duplicated helper flagged by 3 finders). Cluster findings that share a root cause / shared-helper opportunity into one theme, listing member ids.
2. PRIORITIZE: rank themes by leverage = (reach across codebase x maintainability payoff) / (effort x risk). High-confidence, behavior-preserving, high-reach dedup/dead-code wins go first.
3. Assign each theme a wave: "Wave 1 - safe foundations & dead code" (trivial/low-risk, behavior-preserving), "Wave 2 - localized refactors", "Wave 3 - structural / decomposition", "Wave 4 - needs care / verify".
4. Produce a Top-10 highest-leverage recommendations list (cross-domain).
5. Flag any theme that OVERLAPS the scores-compute audit (so the writer cross-references instead of duplicating).

VERIFIED FINDINGS (JSON):
${JSON.stringify(kept)}

Return ONLY the structured object.`
}

function writerPrompt(kept, plan, counts) {
  return `Write the final broad code-health review report to the file /agents/code-health-report.md (use the Write tool). This is the deliverable.

INPUTS:
- VERIFIED FINDINGS (${counts.kept} total, JSON): ${JSON.stringify(kept)}
- PRIORITIZED PLAN (themes, top-10, waves, overlaps — JSON): ${JSON.stringify(plan)}
- Counts: ${JSON.stringify(counts)}
- ${SCORES_DIGEST}

REPORT STRUCTURE (match the repo's existing remediation-tasklist tone — terminal markdown, scannable tables):
1. Title + one-line scope: "Broad Code-Health Review" — repo-wide pass EXCLUDING the scoring layer (already covered).
2. "## Scope & Method" — what was reviewed (26 domains across src/shared/worker/scripts/functions), the find->adversarial-verify->cluster pipeline, and the raw->kept counts.
3. "## Relationship to the Scores-Compute Audit" — point to agents/scores-compute-code-health.md for the scoring layer; list the overlaps from the plan so no one double-implements.
4. "## Executive Summary" — 6-9 bullets naming the biggest cross-cutting opportunities (with rough site counts).
5. "## Top Recommendations" — a ranked table (Rank | Recommendation | Area | Category | Effort | Risk | Why) from the plan's top-10.
6. "## Prioritized Implementation Waves" — for each wave, a checklist table of themes: theme, member finding ids, combined action, effort, risk. These are the actionable tasks.
7. "## Findings by Domain — Full Detail" — group ALL ${counts.kept} kept findings by their domain prefix. Each finding as a compact block: id, title, [category | severity | effort | risk], Problem, Recommendation, Files (with line refs), and the verifier's note/checks-to-run when present. DO NOT DROP ANY finding — every id in the inputs must appear exactly once here.
8. "## Suggested Checks After Each Wave" — the union of check:* / test commands referenced by the findings.

Be faithful: do not invent findings, do not inflate severity, preserve the verifiers' caveats. Keep prose tight. After writing, reply with ONLY: the absolute path, the total finding count you wrote, and a 2-sentence summary.`
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CATEGORY_ENUM = ['duplication','simplification','dead-code','readability','restructure','maintainability','type-safety','test-gap','naming','consistency','performance']
const fileObj = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, lines: { type: 'string' } } }

const FINDER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['domain', 'findings'],
  properties: {
    domain: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id','title','category','severity','effort','risk','files','problem','recommendation','evidence','behaviorPreserving'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          category: { type: 'string', enum: CATEGORY_ENUM },
          severity: { type: 'string', enum: ['high','medium','low'] },
          effort: { type: 'string', enum: ['trivial','small','medium','large'] },
          risk: { type: 'string', enum: ['none','low','medium','high'] },
          files: { type: 'array', items: fileObj },
          problem: { type: 'string' }, recommendation: { type: 'string' },
          evidence: { type: 'string' }, behaviorPreserving: { type: 'boolean' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const VERIFIER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['domain', 'verified'],
  properties: {
    domain: { type: 'string' },
    verified: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id','title','category','severity','effort','risk','files','problem','recommendation','keep','confidence','verificationNote'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          category: { type: 'string', enum: CATEGORY_ENUM },
          severity: { type: 'string', enum: ['high','medium','low'] },
          effort: { type: 'string', enum: ['trivial','small','medium','large'] },
          risk: { type: 'string', enum: ['none','low','medium','high'] },
          files: { type: 'array', items: fileObj },
          problem: { type: 'string' }, recommendation: { type: 'string' },
          keep: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high','medium','low'] },
          alreadyCovered: { type: 'string' },
          verificationNote: { type: 'string' },
          checksToRun: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const CLUSTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['themes', 'topRecommendations', 'overlapsWithScoresReport'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['theme','memberIds','wave','combinedRecommendation','effort','risk'],
        properties: {
          theme: { type: 'string' },
          memberIds: { type: 'array', items: { type: 'string' } },
          wave: { type: 'string' },
          combinedRecommendation: { type: 'string' },
          effort: { type: 'string', enum: ['trivial','small','medium','large'] },
          risk: { type: 'string', enum: ['none','low','medium','high'] },
        },
      },
    },
    topRecommendations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['rank','recommendation','area','category','effort','risk','why'],
        properties: {
          rank: { type: 'integer' }, recommendation: { type: 'string' },
          area: { type: 'string' }, category: { type: 'string' },
          effort: { type: 'string' }, risk: { type: 'string' }, why: { type: 'string' },
        },
      },
    },
    overlapsWithScoresReport: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

const DOMAINS = [
  // Frontend
  { key: 'f-comp-charts', title: 'Frontend — charts & data-viz components', model: 'sonnet', scope:
    `src/components/** that render charts/gauges/sparklines/scatter/maps (e.g. *chart*, *gauge*, *sparkline*, world-map, contagion, dews-badge, scatter). EXCLUDE src/components/ui/ (shadcn primitives). Look for duplicated SVG/scale math, repeated color/scale tables, copy-pasted chart scaffolding, dynamic Tailwind hazards.` },
  { key: 'f-comp-detail', title: 'Frontend — stablecoin-detail components', model: 'sonnet', scope:
    `src/components/stablecoin-detail/**, mechanism-diagrams/**, key-info-card.tsx. Look for repeated card scaffolding, duplicated formatting/derivation that should live in a view-model, near-identical sibling components, prop-drilling that could collapse.` },
  { key: 'f-comp-sections', title: 'Frontend — page sections / tables / status surfaces / badges', model: 'sonnet', scope:
    `src/components/** EXCLUDING ui/, charts, and stablecoin-detail (other agents own those). Page sections, tables (StablecoinTable etc.), status surfaces, badges, cards. Look for duplicated row/cell renderers, repeated badge/label maps, copy-pasted section shells, table-primitive drift (npm run check:table-primitives exists).` },
  { key: 'f-app', title: 'Frontend — app router pages/clients/handlers', model: 'sonnet', scope:
    `src/app/**/{client,page,layout,error,loading}.tsx and src/app/**/route.ts (feed handlers). Prioritize the largest route clients (e.g. src/app/pharoswatchbot/page.tsx ~983 LOC). Look for duplicated metadata wiring, repeated data-massaging in clients that belongs in src/lib, near-identical route layouts.` },
  { key: 'f-lib-vm', title: 'Frontend — view-models & page models', model: 'sonnet', scope:
    `src/lib view-model layer: stablecoin-detail-view-model.ts (~1298 LOC), yield-view-model.ts (~1245), src/lib/coverage/** + coverage.ts, status-dashboard-model.ts, contagion-layout.ts, yield-scatter.ts, comparison*.ts. Look for god-file decomposition, repeated derivation helpers, duplicated formatting, overlapping coverage-module boilerplate.` },
  { key: 'f-lib-misc', title: 'Frontend — src/lib utilities & src/data', model: 'sonnet', scope:
    `src/lib remaining: api.ts, page-metadata.ts, analytics.ts, utils.ts, feature-flags.ts, format/number helpers, selector glue, route-metadata. Plus src/data/** (changelog/annotation data modules). Look for duplicated formatters (USD/percent/date), repeated metadata builders, dead helpers, data modules that could share a builder.` },
  { key: 'f-hooks', title: 'Frontend — TanStack Query hooks', model: 'sonnet', scope:
    `src/hooks/** (api-hooks.ts and the per-feature hooks). Look for repeated useQuery boilerplate, staleTime/refetchInterval policy that should be centralized (check:hook-polling-window exists), duplicated query-key construction, near-identical hook wrappers that a factory could generate.` },

  // Shared (non-score)
  { key: 's-classification', title: 'Shared — classification, supply, type-guards', model: 'sonnet', scope:
    `shared/lib/classification/**, shared/lib/supply.ts, shared/lib/type-guards.ts, shared/lib/classification.ts, mechanism-archetypes. Look for duplicated guard/format helpers vs type-guards.ts, repeated label/color maps, classification logic copied elsewhere.` },
  { key: 's-chains', title: 'Shared — chains registry & L2BEAT (non-scoring)', model: 'sonnet', scope:
    `shared/lib/chains/** EXCLUDING health*.ts (scoring, already covered). l2beat-risk.ts (~893), chain registry/index.ts. Look for duplicated chain lookup tables, repeated risk-tier mapping, data that could be table-driven.` },
  { key: 's-api-cron-meta', title: 'Shared — api-endpoints, cron metadata, origins, functions/', model: 'sonnet', scope:
    `shared/lib/api-endpoints/** (definitions.ts ~819), shared/lib/cron-jobs.ts, scheduled-runner-registry.ts, runtime-origins.ts, site-data-lane.ts, site-csp.ts, AND functions/** (Pages proxy lane). Look for duplicated endpoint descriptors, repeated origin/host logic, proxy handlers sharing copy-pasted gates.` },
  { key: 's-selector', title: 'Shared — screener selector engine', model: 'sonnet', scope:
    `shared/lib/selector/** (22 files ~4700 LOC). Deterministic client engine. Look for duplicated normalization/scoring helpers, repeated profile/threshold tables, near-identical filter predicates, dead exports. Note normalization.ts redefines clamp (already noted in scores audit — only flag NON-clamp dup).` },
  { key: 's-redemption-configs', title: 'Shared — redemption-backstop CONFIGS (not scoring)', model: 'sonnet', scope:
    `shared/lib/redemption-backstop-configs/** (81 files ~7100 LOC) — the per-issuer CONFIG DATA + validation (offchain-issuer/coverage-and-stablecoin-audit.ts ~876, queue-redeem.ts ~848). EXCLUDE redemption-backstop-scoring.ts math. Look for copy-pasted config shapes that could be data-table-driven, duplicated validation helpers, repeated boilerplate across issuer configs.` },
  { key: 's-types', title: 'Shared — type definitions', model: 'sonnet', scope:
    `shared/types/** (status.ts ~1161, market.ts ~814, core.ts, depeg-resolver.ts). Look for overlapping/duplicated interfaces, types that should be unioned/derived, repeated literal-union definitions that could be const-arrays + derived types, over-broad \`any\`/\`unknown\`.` },
  { key: 's-misc', title: 'Shared — remaining lib utilities', model: 'sonnet', scope:
    `shared/lib top-level + small folders NOT owned by other agents and NOT in the scores exclusion: cemetery-merged.ts, citation/**, env-contract/**, telegram-bot-registration.ts, funding/**, runtime-origins.ts helpers, misc utils. Look for duplicated parsing/format/validation helpers, dead exports (check:unused-code, check:duplicate-exports exist), repeated constants.` },

  // Worker
  { key: 'w-api-public', title: 'Worker — public API handlers', model: 'sonnet', scope:
    `worker/src/api/** PUBLIC read handlers (peg-summary.ts ~? , audit-depeg-history.ts ~1138, backfill-supply-history.ts, og/* dynamic). EXCLUDE admin + telegram (other agent). Look for duplicated response-shaping, repeated D1 read+serialize patterns, copy-pasted cache/header wiring, handlers that should share a helper.` },
  { key: 'w-api-admin-msg', title: 'Worker — admin + telegram + OG handlers', model: 'sonnet', scope:
    `worker/src/api admin handlers, telegram-webhook.ts (~1069), webhook-commands/**, telegram-webhook-replies.ts, telegram-mini-app*.ts. Look for duplicated command-handler boilerplate, repeated auth/validation, reply-construction copy-paste, SQL duplicated outside telegram-webhook-store.ts.` },
  { key: 'w-cron-pricing', title: 'Worker — pricing & supply crons', model: 'sonnet', scope:
    `worker/src/cron/sync-stablecoins/**, price-pipeline crons, sync-fx-rates*.ts (~847), fetch-tbill-rate.ts (~1250), supply snapshot/backfill crons. Look for duplicated provider-fetch scaffolding, repeated retry/budget patterns, copy-pasted stage wiring, magic numbers. Respect the 6-connection pool body-consume rule (don't propose changes that break it).` },
  { key: 'w-cron-liquidity-blacklist', title: 'Worker — dex-liquidity, blacklist, yield crons', model: 'sonnet', scope:
    `worker/src/cron/dex-liquidity/** (orchestrator.ts ~814, scoring-helpers, pool-helpers), worker/src/cron/blacklist/** (amount-recovery.ts ~797), yield-coverage-audit.ts (~984). Look for duplicated orchestration stages, repeated pool/venue iteration, copy-pasted blacklist contract decode, shared-stage extraction opportunities.` },
  { key: 'w-cron-digest-recap-tg', title: 'Worker — digest, recap, telegram-dispatch, status crons', model: 'sonnet', scope:
    `worker/src/cron/weekly-recap.ts (~1260), digest crons, dispatch-telegram-alerts.ts (~795) + telegram-pending/**, status-self-check.ts (~801), telegram-alert-snapshots.ts. Look for duplicated section-builders, repeated alert-diff logic, copy-pasted formatting, fan-out boilerplate.` },
  { key: 'w-cron-shared-infra', title: 'Worker — cron shared stages, lease, scheduled handlers', model: 'sonnet', scope:
    `worker/src/cron/shared/** (stage-contracts.ts), worker/src/lib/cron-lease.ts (~901), abort/console contracts, worker/src/handlers/scheduled/**, freshness watchdogs. EXCLUDE compute-depeg-resolver crons (scores). Look for duplicated stage/progress plumbing, repeated lease/abort patterns, copy-pasted scheduled dispatch.` },
  { key: 'w-lib-stores', title: 'Worker — D1 stores & data layer', model: 'sonnet', scope:
    `worker/src/lib data layer: db*.ts, stores, snapshot caches, supply stores, depeg-resolver-incident-store.ts (~1060) / publication-store.ts (~932) [the STORE I/O, not the scoring math], alert-safety-source-cache.ts. Look for duplicated SQL builders, repeated row<->object mapping, copy-pasted upsert/serialize, check:sql-safety patterns.` },
  { key: 'w-lib-infra', title: 'Worker — infra libs (auth, fetch, rate-limit, providers)', model: 'sonnet', scope:
    `worker/src/lib infra: auth, rate-limit, circuit-breaker, fetch/RPC helpers, redstone.ts, address-price-providers/** (non-scoring I/O), mint-burn-contracts-data.ts (~945), blacklist-contracts.ts (~931), request attribution, runtime creds. Look for duplicated fetch+retry, repeated ABI/decode tables, copy-pasted breaker/limit wiring. (median bug in address-price-providers already covered — skip it.)` },
  { key: 'w-routes', title: 'Worker — routing layer & http gates', model: 'sonnet', scope:
    `worker/src/routes/** (shared.ts, registry.ts, domain route arrays, dependency-hydrators.ts), worker/src/router.ts, worker/src/handlers/http/gates.ts. Look for duplicated route-descriptor wiring, repeated method/auth boilerplate, gate logic that could be shared with the site-data lane.` },

  // Scripts
  { key: 'sc-ci', title: 'Scripts — CI guardrails', model: 'sonnet', scope:
    `scripts/ci/** (pharos-change-contract.mjs ~1391, check-seo-static.mjs ~1282, check-telegram-load.ts ~984, the many check-*.ts). Look for duplicated file-walk/parse/AST scaffolding across check scripts, repeated reporting/exit-code patterns, a shared check-harness opportunity, copy-pasted glob+read logic.` },
  { key: 'sc-maint', title: 'Scripts — maintenance & generators + scripts/lib', model: 'sonnet', scope:
    `scripts/maintenance/** (smoke-ui.mjs ~1044, smoke-api.mjs ~878, generate-* artifact generators, audit-* ) and scripts/lib/**. Look for duplicated generator boilerplate (read sources -> validate -> write + checksum), repeated smoke-test scaffolding, shared-lib extraction across generators, dead helpers.` },

  // Cross-cutting (Opus — judgment-heavy)
  { key: 'x-dup-dead', title: 'Cross-cutting — repo-wide duplication, dead code & god-files', model: undefined, scope:
    `REPO-WIDE multi-modal sweep (this is the highest-leverage slice). Run: \`npm run check:unused-code\` and \`npm run check:duplicate-exports\` and \`npm run check:shared-cycles\` and read their output. Grep for repeated idioms across boundaries: date/USD/percent formatters, fetch+JSON+retry wrappers, env/config readers, error-wrapping, isRecord/typeof guards, base64/hex helpers, ENS/address shorteners. Identify the top god-files (>900 LOC, see the largest-file list) that warrant decomposition. Report only CONFIRMED cross-cutting duplication (cite the actual call sites + counts) and CONFIRMED dead/unused code. This slice may legitimately touch any directory.` },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

phase('Find')
log(`Reviewing ${DOMAINS.length} code domains across src / shared / worker / scripts / functions (scoring layer excluded — already audited)`)

const perDomain = await pipeline(
  DOMAINS,
  (d) => agent(finderPrompt(d), { label: `find:${d.key}`, phase: 'Find', schema: FINDER_SCHEMA, model: d.model }),
  (found, d) => {
    if (!found || !Array.isArray(found.findings) || found.findings.length === 0) return { domain: d.key, verified: [] }
    return agent(verifierPrompt(d, found.findings), { label: `verify:${d.key}`, phase: 'Verify', schema: VERIFIER_SCHEMA })
  },
)

// Flatten kept findings (barrier reached: pipeline returned all domains)
const allVerified = perDomain.filter(Boolean).flatMap((r) => (r && Array.isArray(r.verified) ? r.verified : []))
const kept = allVerified.filter((f) => f && f.keep)
const rawCount = perDomain.filter(Boolean).reduce((n, r) => n + (r.verified ? r.verified.length : 0), 0)

log(`Verified ${rawCount} candidate findings -> ${kept.length} survived adversarial review`)

const byCategory = {}
const bySeverity = {}
for (const f of kept) {
  byCategory[f.category] = (byCategory[f.category] || 0) + 1
  bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
}

if (kept.length === 0) {
  return { rawCount, keptCount: 0, byCategory, bySeverity, reportPath: null, note: 'No findings survived verification.' }
}

phase('Cluster')
const plan = await agent(clusterPrompt(kept), { label: 'cluster:prioritize', phase: 'Cluster', schema: CLUSTER_SCHEMA })

phase('Write')
const counts = { raw: rawCount, kept: kept.length, byCategory, bySeverity, domains: DOMAINS.length }
const writeSummary = await agent(writerPrompt(kept, plan, counts), { label: 'write:report', phase: 'Write' })

return {
  rawCount,
  keptCount: kept.length,
  byCategory,
  bySeverity,
  themeCount: plan && plan.themes ? plan.themes.length : 0,
  topRecommendations: plan ? plan.topRecommendations : [],
  overlapsWithScoresReport: plan ? plan.overlapsWithScoresReport : [],
  reportPath: '/home/ahirice/Documents/git/pharos-watch/agents/code-health-report.md',
  writeSummary,
}
