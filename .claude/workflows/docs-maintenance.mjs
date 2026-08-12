export const meta = {
  name: "docs-maintenance",
  description: "Verify docs against code and optionally remediate adjudicated, auto-fixable doc-wrong findings",
  phases: [
    { title: "Load", detail: "read the doc manifest (path, category, depth, source hints)" },
    { title: "Verify", detail: "one agent per doc: extract code-checkable claims, locate code, surface discrepancies" },
    { title: "Adjudicate", detail: "opus skeptic re-verifies each finding against code; default REJECTED" },
    { title: "Synthesize", detail: "dedupe, split auto-fixable vs needs-decision, and return structured findings" },
    { title: "Apply", detail: "mode=remediate only: one agent per doc applies adjudicated auto-fixable findings" },
  ],
};

// ---------------------------------------------------------------------------
// CI ALREADY GUARDS THESE — every agent must treat them as OUT OF SCOPE:
//  - file-path citations in docs            (check:doc-source-paths, passing)
//  - internal doc link targets              (check:verified-doc-links, passing)
//  - methodology version STRINGS            (check:doc-sync, passing) e.g. "v8.0"
//  - AGENTS.md <-> CLAUDE.md sync            (check:generated-artifacts -- --only=agents-doc, passing)
//  - the generated quick-reference block in api-reference.md (check:docs-api-reference: current)
// The workflow targets SEMANTIC / BEHAVIORAL claims that no CI guards.
// ---------------------------------------------------------------------------

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    doc: { type: "string" },
    claimsChecked: { type: "integer", description: "how many concrete claims you located code for and checked" },
    docAccurate: { type: "boolean", description: "true if you found no discrepancies" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          docLine: { type: "integer" },
          docQuote: { type: "string", description: "verbatim doc text, <= 240 chars" },
          claimType: {
            type: "string",
            enum: [
              "formula-threshold-constant",
              "enumeration-list",
              "env-var",
              "d1-table-column",
              "cron-schedule",
              "api-field-shape",
              "behavior-conditional",
              "file-symbol-behavior",
              "count-non-headline",
              "other",
            ],
          },
          whatDocSays: { type: "string" },
          whatCodeDoes: { type: "string" },
          codeEvidence: { type: "string", description: "file:line plus a short code quote that proves whatCodeDoes" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          confidence: { type: "number", description: "0..1; your confidence the code truly contradicts the doc" },
          classification: { type: "string", enum: ["doc-wrong", "code-wrong", "ambiguous"] },
          proposedDocFix: {
            type: "string",
            description: "concrete replacement wording, or DELETE, or a short instruction",
          },
        },
        required: [
          "docLine",
          "docQuote",
          "claimType",
          "whatDocSays",
          "whatCodeDoes",
          "codeEvidence",
          "severity",
          "confidence",
          "classification",
          "proposedDocFix",
        ],
      },
    },
  },
  required: ["doc", "docAccurate", "findings"],
};

const ADJUDICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    doc: { type: "string" },
    adjudicated: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          docLine: { type: "integer" },
          docQuote: { type: "string" },
          verdict: { type: "string", enum: ["CONFIRMED", "REVISED", "REJECTED"] },
          rejectReason: {
            type: "string",
            description: "required when REJECTED: why the doc is actually fine / why the finding is wrong",
          },
          finalClassification: { type: "string", enum: ["doc-wrong", "code-wrong", "ambiguous"] },
          whatCodeDoes: { type: "string" },
          codeEvidence: { type: "string", description: "file:line you personally re-opened to confirm" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          confidence: { type: "number" },
          adjudicatedDocFix: { type: "string", description: "final exact replacement wording for the doc, or DELETE" },
        },
        required: [
          "docLine",
          "verdict",
          "finalClassification",
          "whatCodeDoes",
          "codeEvidence",
          "severity",
          "confidence",
          "adjudicatedDocFix",
        ],
      },
    },
  },
  required: ["doc", "adjudicated"],
};

const APPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    doc: { type: "string" },
    appliedCount: { type: "integer" },
    skippedCount: { type: "integer" },
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          docLine: { type: "integer" },
          status: { type: "string", enum: ["applied", "skipped"] },
          reason: { type: "string" },
        },
        required: ["docLine", "status", "reason"],
      },
    },
  },
  required: ["doc", "appliedCount", "skippedCount", "edits"],
};

const OUT_OF_SCOPE = `OUT OF SCOPE — CI already guards these, do NOT report them:
- existence of file paths cited in the doc (check:doc-source-paths passes)
- internal markdown link targets (check:verified-doc-links passes)
- methodology version STRINGS like "v8.0"/"v5.91" (check:doc-sync passes) — but DO check the formulas/weights/thresholds/bands those versions describe
- AGENTS.md vs CLAUDE.md wording sync (check:generated-artifacts -- --only=agents-doc passes)
- the generated quick-reference block between GENERATED-START/END in api-reference.md (it is generated and verified current); hand-written API prose remains in scope`;

const VERIFY_RULES = `WHAT COUNTS AS A DISCREPANCY (in scope):
- a stated formula, weight, threshold, band boundary, cap, default value, or constant that differs from the code
- a mutable aggregate inventory copied into prose instead of pointing to its source-owned registry or generated report
- an enumerated list (sources, providers, chains, signals, columns, states, fields, steps, kill-switches) that is wrong, incomplete, or includes items the code dropped
- an env var / binding / secret name that the code does not read, or a renamed one
- a D1 table or column name, or schema claim, that differs from migrations / store code
- a cron schedule, cadence, trigger slot, or connection budget that differs from cron-jobs.ts / scheduled-runner-registry / wrangler.toml
- an API request/response field, status code, auth lane, or cache behavior that differs from the route/handler (only for hand-written prose, not the generated catalogue)
- a described conditional behavior ("when X, returns/does Y") that the code does not implement
- a claim that a function/symbol/module does Z when it actually does something else

METHOD:
1. Read your assigned doc to the depth specified above. For targeted oversized docs, use the navigation block and focused Grep/offset reads instead of a wholesale read.
2. Use the source hints, then Grep/Glob/Read (and 'rg' via Bash) to locate the AUTHORITATIVE code for each concrete claim. shared/lib and worker/src are runtime truth; shared/data is data truth.
3. Only flag a claim when you have OPENED the code and it clearly contradicts the doc. Quote file:line as evidence.
4. Set classification: doc-wrong (code is right, doc is stale/incorrect) | code-wrong (doc describes intended behavior, code looks buggy/divergent) | ambiguous.
5. Be generous about surfacing CANDIDATES with honest confidence — a later skeptic pass will reject weak ones. But never fabricate: no evidence => no finding.
6. Ignore editorial rationale, aspirational/roadmap prose, historical narrative, and design taste. Verify facts about current code only.`;

function buildVerifyPrompt(item) {
  const hints =
    item.sourceHints && item.sourceHints.length
      ? `Source hints (owning code from doc-ownership.json): ${item.sourceHints.join(", ")}`
      : "No source hints — Grep/Glob to find the owning code yourself.";
  const noteLine = item.note ? `\nPER-DOC FOCUS (from manifest): ${item.note}\n` : "";
  const depthNote =
    item.depth === "light"
      ? `DEPTH = LIGHT. This is a timeline/version-history or generated map. Do NOT verify historical entries (immutable record). Verify ONLY: (a) the "current"/"latest" version's described formula/behavior matches code, and (b) any "as of today / currently" claims. Sample a few representative entries; skip the rest.`
      : item.depth === "targeted"
        ? `DEPTH = TARGETED. This doc exceeds the wholesale-read limit. Use its Agent navigation block plus Grep/offset reads; never read it wholesale. Skip content between GENERATED-START/END markers, but verify semantic claims in the hand-written sections against handlers, endpoint registries, auth/cache policy, and migrations.`
        : `DEPTH = DEEP. Verify every concrete code-checkable claim in the doc.`;
  return `You are verifying ONE Pharos documentation file against the ACTUAL code. Do not trust the prose — prove each factual claim against the implementation.

DOC: ${item.path}  (category: ${item.category}, ${item.lines} lines)
${hints}
${noteLine}
${depthNote}

${VERIFY_RULES}

${OUT_OF_SCOPE}

Working dir is the repo root. Return findings for ${item.path} only. If the doc is fully accurate, return docAccurate:true with findings:[]. No prose outside the structured output — your structured result IS the deliverable.`;
}

function buildAdjudicatePrompt(item, findings) {
  return `You are an ADVERSARIAL skeptic adjudicating doc-vs-code discrepancy candidates for ONE doc. A first-pass agent flagged these; many will be wrong, over-eager, or based on misreading the code. Your job is to independently re-open the cited code and the doc and decide the truth.

DOC: ${item.path}

CANDIDATE FINDINGS (JSON):
${JSON.stringify(findings, null, 2)}

For EACH candidate:
- Open the doc line and the cited code yourself (Read/Grep). Do not trust the candidate's quotes — verify them.
- Default to REJECTED. Only CONFIRM when the current code clearly contradicts the doc, or REVISE when there is a real but mis-stated discrepancy (then give the corrected description + fix).
- Common reasons to REJECT: the doc is a deliberate simplification that is still true; the candidate misread the code; the claim is CI-guarded (see below); the "code" cited is a test/mock/fixture not runtime; the doc describes a different layer than the code cited; the value actually matches.
- If the doc is RIGHT and the CODE looks buggy/divergent, set finalClassification=code-wrong (we will NOT edit code from this workflow — we flag it).
- adjudicatedDocFix: the exact replacement wording (or DELETE). Make it minimal, surgical, and matching the doc's existing style.

${OUT_OF_SCOPE}

Return one adjudicated entry per candidate (same docLine). Structured output only.`;
}

// ===========================================================================
phase("Load");
const MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    docs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          path: { type: "string" },
          lines: { type: "integer" },
          category: { type: "string" },
          sourceHints: { type: "array", items: { type: "string" } },
        },
        required: ["path", "category"],
      },
    },
  },
  required: ["docs"],
};

// Prefer the manifest injected via args (deterministic, no risk of an LLM loader
// silently dropping doc rows). Fall back to a haiku loader for standalone reuse.
const loaded =
  args && args.docs && args.docs.length
    ? args
    : await agent(
        `Read the file agents/doc-verify/manifest.json (repo root) and return its contents verbatim as {docs:[...]}. Each element has path, lines, category, sourceHints. Do not modify or filter. Structured output only.`,
        { label: "load-manifest", phase: "Load", schema: MANIFEST_SCHEMA, model: "haiku" },
      );

if (!loaded || !loaded.docs || !loaded.docs.length) {
  throw new Error("manifest load failed");
}
// Guard against a loader silently dropping rows: caller passes the expected count.
const expectedDocs = (args && args.expectedDocs) || 0;
if (expectedDocs && loaded.docs.length < expectedDocs) {
  throw new Error(`manifest load incomplete: got ${loaded.docs.length}, expected >= ${expectedDocs}`);
}

// Honor the manifest's per-doc depth; keep timeline archives light and audit
// the oversized, mostly hand-written API reference through targeted reads.
const items = loaded.docs
  .map((d) => {
    let depth = d.depth || "deep";
    if (d.category === "timeline-archive") depth = "light";
    if (d.path.endsWith("api-reference.md")) depth = "targeted";
    return { ...d, depth };
  })
  .filter((d) => d.depth !== "skip");

log(
  `Loaded ${loaded.docs.length} docs; verifying ${items.length}. deep=${items.filter((i) => i.depth === "deep").length} targeted=${items.filter((i) => i.depth === "targeted").length} light=${items.filter((i) => i.depth === "light").length}`,
);

// ===========================================================================
// Pipeline: verify (sonnet) -> adjudicate (opus). No barrier between docs.
const perDoc = await pipeline(
  items,
  (item) =>
    agent(buildVerifyPrompt(item), {
      label: `verify:${item.path.replace("docs/", "")}`,
      phase: "Verify",
      schema: FINDINGS_SCHEMA,
      model: item.model || "sonnet",
    }),
  (verifyResult, item) => {
    const findings = (verifyResult && verifyResult.findings) || [];
    if (!findings.length) return { doc: item.path, adjudicated: [] };
    return agent(buildAdjudicatePrompt(item, findings), {
      label: `adjudicate:${item.path.replace("docs/", "")}`,
      phase: "Adjudicate",
      schema: ADJUDICATION_SCHEMA,
      model: "opus",
    });
  },
);

// Aggregate confirmed/revised findings (plain JS — needs all docs together).
const confirmed = [];
for (const r of perDoc) {
  if (!r || !r.adjudicated) continue;
  for (const a of r.adjudicated) {
    if (a.verdict === "CONFIRMED" || a.verdict === "REVISED") {
      confirmed.push({ doc: r.doc, ...a });
    }
  }
}
log(
  `Adjudication complete: ${confirmed.length} confirmed/revised findings across ${new Set(confirmed.map((c) => c.doc)).size} docs`,
);

// ===========================================================================
phase("Synthesize");
// Deterministic synthesis — NO LLM on the persist/serialize step (repo memory
// [No LLM on serialization stage]: the single-Write agent hard-fails at the 32k
// output cap with large finding sets). Dedup + partition are simple rules; the caller
// writes report.md + findings.json deterministically from this return value.
const seen = new Set();
const deduped = [];
for (const c of confirmed) {
  const key = `${c.doc}|${c.docLine}|${(c.docQuote || "").slice(0, 80)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(c);
}
const isAutoFixable = (c) =>
  c.finalClassification === "doc-wrong" &&
  (c.confidence ?? 0) >= 0.7 &&
  typeof c.adjudicatedDocFix === "string" &&
  c.adjudicatedDocFix.trim().length > 0 &&
  !/^\s*(investigate|review|tbd|unclear|consider|verify)\b/i.test(c.adjudicatedDocFix);
const autoFixable = deduped.filter(isAutoFixable);
const needsDecision = deduped.filter((c) => !isAutoFixable(c));
const bySeverity = {};
for (const c of deduped) bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
log(
  `Synthesis: ${deduped.length} unique confirmed (${autoFixable.length} auto-fixable, ${needsDecision.length} needs-decision) across ${new Set(deduped.map((c) => c.doc)).size} docs`,
);

const summary = {
  totalConfirmed: deduped.length,
  autoFixableCount: autoFixable.length,
  needsDecisionCount: needsDecision.length,
  bySeverity,
  docsWithIssues: new Set(deduped.map((c) => c.doc)).size,
  docsVerified: items.length,
  autoFixable,
  needsDecision,
};

if ((args && args.mode) !== "remediate" || autoFixable.length === 0) {
  return summary;
}

phase("Apply");
const byDoc = {};
for (const finding of autoFixable) (byDoc[finding.doc] ||= []).push(finding);
const entries = Object.keys(byDoc)
  .sort()
  .map((doc) => ({ doc, findings: byDoc[doc] }));

function buildApplyPrompt(entry) {
  return `You are applying independently verified documentation fixes to ONE file: ${entry.doc}. Working dir is the repo root.

FIXES (JSON):
${JSON.stringify(entry.findings, null, 2)}

For each fix:
1. Read the doc and locate the stale claim by content; line numbers may have shifted.
2. Re-open the cited code evidence. If current code no longer supports the adjudicated finding, skip it.
3. Apply the smallest faithful edit. Preserve surrounding Markdown, tables, and style. Adapt adjudicatedDocFix to the sentence rather than pasting awkwardly; DELETE removes only the stale clause or sentence.
4. Do not edit unrelated claims or runtime code.

Return one structured edits[] entry per fix with applied/skipped status and a short reason.`;
}

const applyResults = await parallel(
  entries.map(
    (entry) => () =>
      agent(buildApplyPrompt(entry), {
        label: `fix:${entry.doc.replace("docs/", "")}`,
        phase: "Apply",
        schema: APPLY_SCHEMA,
        model: "sonnet",
      }),
  ),
);
const appliedResults = applyResults.filter(Boolean);
const applied = appliedResults.reduce((count, result) => count + (result.appliedCount || 0), 0);
const skipped = appliedResults.reduce((count, result) => count + (result.skippedCount || 0), 0);
log(`Applied ${applied}, skipped ${skipped} across ${appliedResults.length}/${entries.length} docs`);

return {
  ...summary,
  remediation: {
    applied,
    skipped,
    docsProcessed: appliedResults.length,
    perDoc: appliedResults.map((result) => ({
      doc: result.doc,
      applied: result.appliedCount,
      skipped: result.skippedCount,
    })),
  },
};
