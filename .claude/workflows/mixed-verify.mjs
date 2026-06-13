export const meta = {
  name: 'mixed-verify',
  description: 'Mixed-model verification harness: Claude (Opus) plans & adversarially judges & synthesizes; GPT-5.5 (or gpt-5.3-codex-spark per item) executes each check via the Codex companion. Reusable for static data verification, audits, and reviews.',
  phases: [
    { title: 'Plan' },
    { title: 'Verify' },
    { title: 'Adversarial' },
    { title: 'Synthesize' },
  ],
}

// ---- config (all via args) -------------------------------------------------
// args = {
//   target:   string  — what is being verified (path, dataset, description)
//   items?:   (string | {id, focus?, model?, effort?, spark?})[]
//             explicit work-list. Strings use the default executor.
//             Set spark:true on MECHANICAL / speed-priority items (presence,
//             format, enum, checksum checks) to route them to the fast spark
//             model; leave judgment-heavy items on the default GPT-5.5 executor.
//   checks:   string  — the verification rubric each item must satisfy
//   executor?: {model, effort}   default {gpt-5.5, high}
//   spark?:    {model, effort}   default {gpt-5.3-codex-spark, xhigh}
//   adversarial?: boolean        default true  (Claude second opinion)
//   advModel?: 'sonnet'|'haiku'  optional — cheapen the adversarial judgment on
//                                big sweeps; default inherits the session model (Opus)
//   maxItems?: number            default 50
// }
const cfg = args || {}
const TARGET = cfg.target || '(unspecified target)'
const CHECKS = cfg.checks || 'Verify the item is internally consistent and factually correct.'
const EXEC = cfg.executor || { model: 'gpt-5.5', effort: 'high' }
const SPARK = cfg.spark || { model: 'gpt-5.3-codex-spark', effort: 'medium' }
const ADVERSARIAL = cfg.adversarial !== false
const ADV_MODEL = cfg.advModel // undefined → inherit session model (Opus)
const MAX = cfg.maxItems || 50

// The script sandbox has no filesystem, so the Codex companion path is resolved
// inside the Bash node (glob picks the newest installed plugin version — survives
// plugin updates that bump the version-pinned directory). --effort 'minimal' is
// intentionally never used: it 400s against the user's image_gen/web_search tools.
function gptNode(taskText, { model, effort, label }) {
  const m = model || EXEC.model
  const e = effort || EXEC.effort
  // The "[codex] ..." progress lines are stripped in-shell so only GPT's final
  // answer remains. The wrapper node does no reasoning — it's a pure forwarder —
  // so it runs on Haiku; the real work happens in the Codex/GPT call it shells to.
  const cmd =
    `CODEX=$(ls -t ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | head -1); ` +
    `node "$CODEX" task --effort ${e} --model ${m} ${JSON.stringify(taskText)} 2>&1 | grep -v '^\\[codex\\]'`
  return agent(
    `Run EXACTLY this one Bash command and return ONLY its stdout verbatim, with no commentary:\n\n${cmd}`,
    { label: label || `gpt:${m}`, phase: 'Verify', model: 'haiku' }
  )
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: { id: { type: 'string' }, focus: { type: 'string' } },
  } } },
}
const ADV_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['item', 'gptVerdictSound', 'finalVerdict'],
  properties: {
    item: { type: 'string' },
    gptVerdictSound: { type: 'boolean' },
    finalVerdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    note: { type: 'string' },
  },
}

// ---- Plan: use provided items, else let Claude enumerate from target -------
phase('Plan')
log(`target=${TARGET} | executor=${EXEC.model}@${EXEC.effort} | spark=${SPARK.model}@${SPARK.effort} | adversarial=${ADVERSARIAL}`)
let items = Array.isArray(cfg.items) ? cfg.items : null
if (!items) {
  const plan = await agent(
    `Enumerate the discrete, independently-verifiable work-items for this target so each can be checked in isolation by a separate model call.\n\nTarget: ${TARGET}\nChecks to be applied per item: ${CHECKS}\n\nReturn JSON {items:[{id, focus}]}. Keep ids stable/identifying (e.g. file paths or record ids).`,
    { schema: PLAN_SCHEMA, label: 'plan', phase: 'Plan' }
  )
  items = (plan?.items || [])
}
items = items.map((it) => (typeof it === 'string' ? { id: it } : it))
if (items.length === 0) {
  log('No items to verify.')
  return { target: TARGET, itemsChecked: 0, report: 'No items were enumerated for verification.' }
}
if (items.length > MAX) {
  log(`maxItems=${MAX}: verifying first ${MAX} of ${items.length}. DROPPED: ${items.slice(MAX).map((i) => i.id).join(', ')}`)
  items = items.slice(0, MAX)
}

// ---- Verify (GPT) -> Adversarial (Claude), pipelined per item --------------
const results = await pipeline(
  items,
  // Stage 1 — GPT executor: judgment items on gpt-5.5; mechanical/speed items
  // flagged spark:true run on the fast gpt-5.3-codex-spark model
  (it) => {
    const useSpark = it.spark === true || it.tier === 'spark'
    const model = it.model || (useSpark ? SPARK.model : EXEC.model)
    const effort = it.effort || (useSpark ? SPARK.effort : EXEC.effort)
    const prompt =
      `${CHECKS}\n\nItem: ${it.id}${it.focus ? `\nFocus: ${it.focus}` : ''}\n\n` +
      `Respond with ONE compact JSON line and nothing else: ` +
      `{"item":"${it.id}","verdict":"pass|fail|uncertain","confidence":0-1,"issues":["..."],"fix":"..."}`
    return gptNode(prompt, { model, effort, label: `gpt:${it.id}` }).then((out) => ({ item: it.id, model, effort, raw: out }))
  },
  // Stage 2 — Claude (Opus) adversarial second opinion (cross-model check)
  (r, it) => {
    if (!ADVERSARIAL || r == null) return r
    return agent(
      `A GPT verifier (${r.model}@${r.effort}) checked item "${it.id}" against these rules:\n${CHECKS}\n\n` +
      `GPT output:\n${r.raw}\n\n` +
      `As an independent Claude reviewer, adversarially assess whether the GPT verdict is correct. Confirm or refute with brief reasoning. ` +
      `Return JSON {item, gptVerdictSound, finalVerdict, note}.`,
      { schema: ADV_SCHEMA, label: `adv:${it.id}`, phase: 'Adversarial', ...(ADV_MODEL ? { model: ADV_MODEL } : {}) }
    ).then((v) => ({ ...r, adversarial: v }))
  }
)

// ---- Synthesize (Claude/Opus) ---------------------------------------------
phase('Synthesize')
const clean = results.filter(Boolean)
const report = await agent(
  `Synthesize a verification report for target "${TARGET}". ${clean.length} items checked by GPT${ADVERSARIAL ? ' with a Claude adversarial pass' : ''}.\n\n` +
  `Per-item results (JSON):\n${JSON.stringify(clean).slice(0, 120000)}\n\n` +
  `Produce markdown with: (1) summary counts pass/fail/uncertain; (2) confirmed failures with their fixes; (3) items where GPT and Claude DISAGREED (gptVerdictSound:false) flagged for human review; (4) any low-confidence items. Be concise and actionable.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return { target: TARGET, itemsChecked: clean.length, report, raw: clean }
