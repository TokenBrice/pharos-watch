// Generates the V9 evidence-curation worklist from a V9 replay:
// one checkbox item per (asset, workstream), ordered by supply weight, with
// the exact reason codes and paths that currently bound the asset. Agents
// walk the generated document to completion and regenerate it after each
// batch; an item disappears from the regenerated list when its codes clear.
//
// Two classes of open reason are routed out of the default sweep instead of
// into it, without removing anything from the typed registry:
//   - documentation-class gaps (policy `semantic.evidence.documentation`):
//     hidden from the streams and listed only in the documentation band that
//     `--include-documentation` appends. The class is read from the
//     evidence-gap queue's copy of the shared classifier — never re-derived.
//   - parked claim groups (ledger churn policy): hidden from every band. The
//     park state is read from the reviewed ledger through the ledger tooling's
//     own predicate — never re-derived.
//
// Usage:
//   npm run safety-score-v9:curation-worklist -- \
//     --replay <replay-v9.json> [--output <worklist.md>] \
//     [--ledger <reviewed-ledger.json>] [--include-documentation]
// (The .ts imports resolve through tsconfig paths, so run via the npm script's
// `node --import tsx` — bare `node` cannot resolve @shared/lib.)
import { readFileSync, writeFileSync } from "node:fs";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "../../shared/lib/methodology-versions/constants.ts";
import {
  buildV9EvidenceGapQueue,
  isV9DocumentationGapEntry,
} from "../../shared/lib/safety-score-v9/evidence-gap-queue.ts";
import { loadV9MethodologyPolicy } from "../../shared/lib/safety-score-v9/policy.ts";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources.ts";
import {
  classifyV9CurationWorklistStream,
  generateV9MissingDataRegistry,
} from "./generate-safety-score-v9-missing-data-registry.ts";
import { PRIORITY_BANDS, priorityBand } from "../lib/safety-score-v9-missing-data-work-types.ts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const POLICY_PATH = new URL(
  "../../shared/data/safety-score-v9/methodology-policy-candidate-v1.json",
  import.meta.url,
);
const DEFAULT_LEDGER_PATH = ".github/artifacts/safety-score-missing-data-reviewed-ledger.json";

const STREAMS = [
  {
    key: "CTRL",
    title: "Control — mint / upgrade / control identity",
    ceiling: "cause-scoped control components; no missing-data cap",
    fix: "Resolve the asset's mintAuthority block in shared/data/stablecoins/domains/mint-authority/<id>.json and related control reviews in shared/data/stablecoins/domains/risk-review/<id>.json: mint path, authority type + threshold, cap semantics, upgradeability model and controlRef, per-control evidence with sources. Mostly deterministic explorer/RPC reads (proxy admin slots, owner()/minters(), multisig thresholds); RPC endpoints and structural-blocker notes are in the mint-authority verified-campaign memory. Multichain assets need every deployment's authority graph.",
  },
  {
    key: "ORCL",
    title: "Oracle — profile and CDP branch reviews",
    ceiling: "cause-scoped oracle components; no missing-data cap",
    fix: "Populate/complete the oracleRisk block (tier, branch applicability disposition, per-branch feed/collateral-parameter/liquidation/backstop/shutdown reviews) in shared/data/stablecoins/domains/risk-review/<id>.json. CDP-family assets need the branch-applicability ruling; non-oracle designs need an explicit not-applicable review.",
  },
  {
    key: "BRDG",
    title: "Bridge — route reviews and supply materiality",
    ceiling: "cause-scoped bridge components; no missing-data cap",
    fix: "Review the runtime-selected bridge routes (bridgeRoutes rows: route kind, verification model, controls) so selected routes resolve and bridged supply matches reviewed rows. The static P7 route research queue feeds this; only runtime-selected scoring routes matter here.",
  },
  {
    key: "RESV",
    title: "Backing — reserve envelope, composition, assurance",
    ceiling: "identified reserves plus cause-bearing remainder",
    fix: "Author or refresh structured whole-asset reserve evidence from current primary sources: identified holdings, independently established denominator, reserveReview and named-firm reports (admissible up to 120 days at their actual strength). Keep the unidentified remainder with its exact cause. Never restate expired evidence or infer current composition from selected slices.",
  },
  {
    key: "MECH",
    title: "Mechanism — curated overlay for measured-ratio archetypes",
    archetypes: ["cdp", "synthetic-delta-neutral", "algorithmic", "rwa-credit-fund"],
    ceiling: "comparable ordinary-family uncertainty credit; proven A/B excluded",
    fix: "Author a sourced overlay in shared/data/safety-score-v9/mechanism-review-overlays-v1.json (archetype-specific components + REQUIRED measured metrics, e.g. CDP collateralizationRatio/liquidationCapacityRatio). NO FABRICATION: only author when an honest live source exists (bold-liquity via api.liquity.org is the template). CONFIRMED BLOCKED (2026-07-13 + independently re-verified by mechanism batch 01, 2026-07-14 — do not re-research): DAI/USDS (auction Hole limits are governance caps, not committed liquidation capital; no reproducible system CR), USDe (reserve fund observable, hedge notional/margin buffers not public), USDD (vault-only CR must not be applied to total supply; non-vault issuance routes), USDf-Falcon (insurance fund observable, empty venue map, no hedge measurements), crvUSD (PegKeeper share needs decomposition), LUSD (needs on-chain TCR read — the one actionable path). Expect most of this stream to stay blocked until issuers publish ratios or on-chain readers are built.",
  },
  {
    key: "EXIT",
    title: "Exit — same-notional route evidence",
    ceiling: "cause-scoped route factors; no missing-data cap",
    fix: "Best lever per asset: (a) a resolved redemption row (redemption methodology v" + REDEMPTION_BACKSTOP_METHODOLOGY_VERSION + " derives a bounded exit observation from a supply-full row with documented fixed-bps fee), (b) unresolved-exit-output routes: set `outputAssets` on the asset's entry in shared/lib/redemption-backstop-configs/ — tracked stablecoin ids for stable-single/stable-basket, canonical asset:<symbol> keys for collateral; ONLY when the documented rail names the output (config notes/docs are the source; schema validates shape), (c) exact DEX capacity where the pool archetype is supported (raydium CP, balancer weighted). Captures with producer-embedded observations pick up outputAssets on the next production capture. CL-pool exact capacity is producer tick-data work, not per-asset curation — do not grind unsupported pools by hand.",
  },
  {
    key: "PEG",
    title: "Peg — missing peg rows",
    ceiling: "measured deviation and bounded uncertainty; no missing-data cap",
    fix: "Ensure the asset has a peg row (pegCurrency resolvable, price feed tracked) or a reviewed NAV/not-applicable ruling (flags.navToken for pure NAV designs). OTHER-peg assets need the peg building blocks first — check the GELT/OTHER-peg parked memory before grinding.",
  },
  {
    key: "DEP",
    title: "Dependencies — unreviewed relationship sets",
    ceiling: "actual upstream status and cause; no missing-data cap",
    fix: "Review the effective dependency set (collateral mapping to reserve exposures must be exact; serial wrapper/mechanism edges explicit). material-dependency-unavailable clears when the upstream asset becomes rateable — check the upstream first.",
  },
  {
    key: "ARCH",
    title: "Archetype — unresolved classification",
    ceiling: "classification and cause-aware rateability",
    fix: "Assign a sourced mechanism archetype through resilience-classify. A classification gap does not prove a pipeline or public-curation cause; use the compiled exact gap scope and evidence proof.",
  },
];

/**
 * Render the markdown worklist.
 *
 * @param {object} replay parsed V9 replay artifact
 * @param {object} registry typed missing-data registry for the same replay
 * @param {string} replayPath path shown in the header
 * @param {object} [options]
 * @param {boolean} [options.includeDocumentation] list the non-scoring documentation band
 * @param {ReadonlyMap<string, { reason: string }>} [options.documentationGaps]
 *   gapId -> documentation classification copied from the evidence-gap queue
 * @param {ReadonlySet<string>} [options.parkedClaimGroups] claim group ids parked by the ledger churn rule
 */
export function renderCurationWorklist(replay, registry, replayPath, options = {}) {
const includeDocumentation = options.includeDocumentation === true;
const documentationGaps = options.documentationGaps ?? new Map();
const parkedClaimGroups = options.parkedClaimGroups ?? new Set();
const cards = replay.pipeline.candidate.cards;
if (registry.summary.stablecoinCount !== cards.length) {
  throw new Error("Typed missing-data registry and replay card counts differ");
}
const assets = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
const registryAssets = new Map(registry.stablecoins.map((asset) => [asset.assetId, asset]));
// The registry is the only map from a compiled gap to its claim group; both
// bands key on that identity, never on a reason code or a work-type guess.
const claimGroupByGapId = new Map();
for (const asset of registry.stablecoins) {
  for (const row of asset.missingItems ?? []) {
    if (typeof row.gapId === "string" && typeof row.claimGroupId === "string") {
      claimGroupByGapId.set(row.gapId, row.claimGroupId);
    }
  }
}

function money(value) {
  if (value === null) return "unavailable (missing-captured-supply)";
  if (value === 0) return "$0";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value / 1e3)}k`;
}

// Gap identity for a replay reason. `causeGapIds` is the projected witness
// list; a reason without one (synthetic or overlay) has no gap and therefore
// can never be hidden by either band.
function reasonGapIds(reason) {
  const ids = Array.isArray(reason.causeGapIds)
    ? reason.causeGapIds.filter((gapId) => typeof gapId === "string")
    : [];
  if (ids.length > 0) return ids;
  return typeof reason.sourceGapId === "string" ? [reason.sourceGapId] : [];
}

// Every witness must resolve to a parked claim group; one unresolved or active
// witness keeps the reason in the default sweep (fail-closed).
function parkedGroupsOf(reason) {
  const gapIds = reasonGapIds(reason);
  if (gapIds.length === 0) return null;
  const groups = new Set();
  for (const gapId of gapIds) {
    const claimGroupId = claimGroupByGapId.get(gapId);
    if (claimGroupId === undefined || !parkedClaimGroups.has(claimGroupId)) return null;
    groups.add(claimGroupId);
  }
  return groups;
}

// Same fail-closed composition for the documentation class: every witness gap
// must carry the classifier's class.
function documentationOf(reason) {
  const gapIds = reasonGapIds(reason);
  if (gapIds.length === 0) return null;
  const reasons = new Set();
  for (const gapId of gapIds) {
    const classification = documentationGaps.get(gapId);
    if (classification === undefined) return null;
    reasons.add(classification.reason);
  }
  return { gapIds, reasons };
}

const items = new Map(); // `${stream}:${assetId}` -> { codes, documentationCodes, documentationReasons, documentationGapIds, critical }
function addCode(codes, code, path) {
  const paths = codes.get(code) ?? new Set();
  if (path) paths.add(path);
  codes.set(code, paths);
}

function addItem(streamKey, assetId, code, path, critical = false, documentation = null) {
  const key = `${streamKey}:${assetId}`;
  const item = items.get(key) ?? {
    streamKey,
    assetId,
    critical: false,
    codes: new Map(),
    documentationCodes: new Map(),
    documentationReasons: new Set(),
    documentationGapIds: new Set(),
  };
  if (documentation === null) {
    addCode(item.codes, code, path);
    item.critical ||= critical;
  } else {
    addCode(item.documentationCodes, code, path);
    for (const reason of documentation.reasons) item.documentationReasons.add(reason);
    for (const gapId of documentation.gapIds) item.documentationGapIds.add(gapId);
  }
  items.set(key, item);
}

let parkedReasonCount = 0;
const parkedGroupsSeen = new Set();
function addRoutedItem(streamKey, assetId, reason, code, path, critical) {
  const parked = parkedGroupsOf(reason);
  if (parked !== null) {
    parkedReasonCount += 1;
    for (const claimGroupId of parked) parkedGroupsSeen.add(claimGroupId);
    return;
  }
  addItem(streamKey, assetId, code, path, critical, documentationOf(reason));
}

for (const card of cards) {
  const asset = assets.get(card.id);
  const criticalReasonCodes = new Set(
    registryAssets.get(card.id)?.missingItems
      .filter((item) => item.critical)
      .map((item) => item.reasonCode) ?? [],
  );
  const lanes = [
    ...["backing", "exit", "control"].flatMap((pillar) => asset.scoreInput.pillars[pillar].reasons),
    ...asset.scoreInput.peg.reasons,
    ...asset.scoreInput.dependencyReasons,
  ];
  for (const reason of lanes) {
    const streamKey = classifyV9CurationWorklistStream(reason.code);
    if (streamKey) {
      addRoutedItem(streamKey, card.id, reason, reason.code, reason.path, criticalReasonCodes.has(reason.code));
    }
  }
  for (const reason of card.nrReasons ?? []) {
    const streamKey = classifyV9CurationWorklistStream(reason.code);
    if (streamKey) {
      addRoutedItem(streamKey, card.id, reason, reason.code, reason.field ?? null, criticalReasonCodes.has(reason.code));
    }
  }
  const mechStream = STREAMS.find((stream) => stream.key === "MECH");
  if (
    mechStream.archetypes.includes(asset.backing.archetype) &&
    asset.backing.contributions.some(
      (entry) => entry.source === "mechanism" && entry.observationState !== "known",
    )
  ) {
    addItem("MECH", card.id, `overlay:${asset.backing.archetype}`, null);
  }
}

const isDocumentationOnly = (item) => item.codes.size === 0 && item.documentationCodes.size > 0;
const openItems = [...items.values()];
const requiredItems = openItems.filter((item) => !isDocumentationOnly(item));
const documentationItems = openItems.filter(isDocumentationOnly);
const defaultCauseRowsOf = (assetId) =>
  (registryAssets.get(assetId)?.missingItems ?? []).filter((row) =>
    row.cause !== undefined &&
    !(typeof row.claimGroupId === "string" && parkedClaimGroups.has(row.claimGroupId)) &&
    !(typeof row.gapId === "string" && documentationGaps.has(row.gapId)));

const supplyOf = (assetId) => {
  const supply = assets.get(assetId)?.stressState?.exitPortfolio?.circulatingUsd;
  return typeof supply === "number" && Number.isFinite(supply) && supply >= 0 ? supply : null;
};
const knownCards = cards.filter((card) => supplyOf(card.id) !== null);
const knownSupplySubtotal = knownCards.reduce((sum, card) => sum + supplyOf(card.id), 0);
const ratedKnownSupplySubtotal = knownCards
  .filter((card) => card.ratingStatus === "rated")
  .reduce((sum, card) => sum + supplyOf(card.id), 0);

const lines = [];
lines.push("# V9 evidence-curation worklist (generated — do not hand-edit rows)");
lines.push("");
for (const warning of registry.summary.warnings) {
  lines.push(`> **Warning:** ${warning}`);
}
if (registry.summary.warnings.length > 0) lines.push("");
lines.push(`Generated from \`${replayPath.split("/").pop()}\` (${cards.length} cards, ` +
  `${cards.filter((card) => card.ratingStatus === "rated").length} rated, ${cards.filter((card) => card.ratingStatus === "pipeline-gap").length} pipeline-gap). ` +
  "Regenerate after every merged batch:");
lines.push("");
lines.push(`Supply availability: ${knownCards.length} known (including observed zero), ${cards.length - knownCards.length} unavailable. Known-supply subtotal: ${money(knownSupplySubtotal)}; not a full-cohort total.`);
lines.push(`Rated share of known supply only: ${knownSupplySubtotal > 0 ? `${(100 * ratedKnownSupplySubtotal / knownSupplySubtotal).toFixed(2)}%` : "unavailable (zero known-supply denominator)"}; not full-cohort supply coverage.`);
lines.push("");
lines.push("```bash");
lines.push("# 0. npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts  # generated catalog aggregate is gitignored and goes stale against coin edits");
lines.push("# 1. fresh exact capture + replay");
lines.push("# 2. npm run safety-score-v9:curation-worklist -- --replay <replay.json> --output <this file>");
lines.push("#    add --include-documentation to append the non-scoring documentation band");
lines.push("```");
lines.push("");
lines.push("## Protocol for agents");
lines.push("");
for (const [index, instruction] of Object.values(registry.agentProtocol).entries()) {
  lines.push(`${index + 1}. ${instruction}`);
}
lines.push("");
lines.push("Item ID format: `STREAM-assetId`. An item is DONE when none of its listed reason codes appear for the asset in a fresh replay.");
lines.push("");
lines.push("**Cause protocol:** A requires captured failed-producer evidence; B requires a reviewed exact public datum; C requires researched non-disclosure; U requires research before attribution. A/B gaps are excluded, not favorable facts. C/U stay bounded without missing-data caps. Resolve the exact gap scope, not the display responsibility label.");
lines.push("");

lines.push("## Summary");
lines.push("");
lines.push("| Stream | Items | Documentation | Scoring scope |");
lines.push("|---|---|---|---|");
for (const stream of STREAMS) {
  const count = requiredItems.filter((item) => item.streamKey === stream.key).length;
  const documentationCount = documentationItems.filter((item) => item.streamKey === stream.key).length;
  lines.push(`| ${stream.key} | ${count} | ${documentationCount} | ${stream.ceiling} |`);
}
lines.push(`| **Total** | **${requiredItems.length}** | **${documentationItems.length}** | |`);
lines.push("");
if (documentationItems.length > 0 && !includeDocumentation) {
  lines.push(`Documentation-class items are not in the streams: **${documentationItems.length}** hidden (rerun with \`--include-documentation\` to list them in the documentation band).`);
  lines.push("");
}
if (parkedGroupsSeen.size > 0) {
  lines.push(`Parked claim groups are hidden from every band: **${parkedGroupsSeen.size}** groups (${parkedReasonCount} open reasons). They stay in the typed registry and the reviewed ledger; a group leaves the park state only through an explicit \`unpark\` decision.`);
  lines.push("");
}

function sortStreamItems(list) {
  return [...list].sort((left, right) => {
    if (left.critical !== right.critical) return left.critical ? -1 : 1;
    const leftSupply = supplyOf(left.assetId);
    const rightSupply = supplyOf(right.assetId);
    if (leftSupply === null && rightSupply !== null) return -1;
    if (rightSupply === null && leftSupply !== null) return 1;
    const leftPriority = priorityBand(left.critical, leftSupply);
    const rightPriority = priorityBand(right.critical, rightSupply);
    const priorityOrder = PRIORITY_BANDS.indexOf(leftPriority) - PRIORITY_BANDS.indexOf(rightPriority);
    return priorityOrder || (rightSupply ?? 0) - (leftSupply ?? 0) || left.assetId.localeCompare(right.assetId);
  });
}

function renderCodes(codes) {
  return [...codes.entries()]
    .map(([code, paths]) => {
      const list = [...paths].slice(0, 4).join(", ");
      const extra = paths.size > 4 ? ` +${paths.size - 4}` : "";
      return paths.size > 0 ? `${code} (${list}${extra})` : code;
    })
    .join("; ");
}

function v9Status(assetId) {
  const card = cards.find((entry) => entry.id === assetId);
  return card.ratingStatus === "pipeline-gap" ? "Pipeline gap" : `${card.grade}/${card.score ?? "—"}`;
}

for (const stream of STREAMS) {
  const streamItems = sortStreamItems(requiredItems.filter((item) => item.streamKey === stream.key));
  lines.push(`## ${stream.key} — ${stream.title} (${streamItems.length})`);
  lines.push("");
  lines.push(`**Scoring scope:** ${stream.ceiling}. **How to fix:** ${stream.fix}`);
  lines.push("");
  if (streamItems.length === 0) {
    lines.push("_No open items._");
    lines.push("");
    continue;
  }
  lines.push("| ☐ | ID | Pri | Supply | V9 status | Causes and gap IDs | Codes (paths) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const item of streamItems) {
    const supply = supplyOf(item.assetId);
    const causes = defaultCauseRowsOf(item.assetId)
      .map((row) => `${row.cause}: ${row.gapId}`).join("; ") ||
      ((registryAssets.get(item.assetId)?.missingItems ?? []).some((row) => row.cause !== undefined)
        ? "— (this row's causes are documentation-class or parked)"
        : "U: score-projection-only (research required)");
    lines.push(
      `| ☐ | ${stream.key}-${item.assetId} | ${supply === null && !item.critical ? "unknown supply" : priorityBand(item.critical, supply)} | ${money(supply)} | ` +
        `${v9Status(item.assetId)} | ${causes} | ${renderCodes(item.codes)} |`,
    );
  }
  lines.push("");
}

if (includeDocumentation) {
  const documentationStreamItems = sortStreamItems(documentationItems);
  lines.push(`## DOC — Documentation class, non-scoring (${documentationStreamItems.length})`);
  lines.push("");
  lines.push("**Scoring scope:** none. These gaps cannot materially move a published score under policy `semantic.evidence.documentation`, so they sit outside the default streams. They stay open facts in the registry: never close them by date-bump, and they re-enter the streams automatically when a threshold no longer holds.");
  lines.push("");
  if (documentationStreamItems.length === 0) {
    lines.push("_No documentation-class items._");
    lines.push("");
  } else {
    lines.push("| ID | Stream | Pri | Supply | V9 status | Documentation reason | Causes and gap IDs | Codes (paths) |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const item of documentationStreamItems) {
      const supply = supplyOf(item.assetId);
      const causes = (registryAssets.get(item.assetId)?.missingItems ?? [])
        .filter((row) => row.cause !== undefined && item.documentationGapIds.has(row.gapId))
        .map((row) => `${row.cause}: ${row.gapId}`).join("; ");
      lines.push(
        `| ${item.streamKey}-${item.assetId} | ${item.streamKey} | ${supply === null && !item.critical ? "unknown supply" : priorityBand(item.critical, supply)} | ${money(supply)} | ` +
          `${v9Status(item.assetId)} | ${[...item.documentationReasons].join("; ")} | ${causes || "—"} | ${renderCodes(item.documentationCodes)} |`,
      );
    }
    lines.push("");
  }
}

return lines.join("\n");
}

/**
 * Documentation-class gaps, copied verbatim from the evidence-gap queue (which
 * owns the classifier call). Never re-derive the predicate here.
 */
function collectDocumentationGaps(replay, policy) {
  const queue = buildV9EvidenceGapQueue({
    factSet: replay.pipeline.compiledFacts,
    policy: loadV9MethodologyPolicy(policy),
  });
  const documentationGaps = new Map();
  for (const entry of queue.entries) {
    if (isV9DocumentationGapEntry(entry)) documentationGaps.set(entry.gapId, entry.documentation);
  }
  return documentationGaps;
}

/**
 * Parked claim groups, read through the ledger tooling's own churn predicate.
 * The ledger module ships with the tooling/durability branch, so the worklist
 * must not grow a second copy of the rule: without the module the CLI stops
 * instead of silently claiming that nothing is parked.
 */
async function collectParkedClaimGroups(ledgerPath) {
  let ledgerTooling;
  try {
    ledgerTooling = await import("./ledger-append.ts");
  } catch (error) {
    throw new Error(
      "Parked-group suppression needs scripts/maintenance/ledger-append.ts (durability/tooling branch). " +
      `Rebase before regenerating worklists. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { ledger } = ledgerTooling.readCurationLedger(ledgerPath);
  const parked = new Set();
  for (const [claimGroupId, state] of ledgerTooling.curationLedgerParkState(ledger.decisions)) {
    if (state === "parked") parked.add(claimGroupId);
  }
  return parked;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const replayPath = arg("--replay");
if (!replayPath) {
  console.error(
    "Usage: npm run safety-score-v9:curation-worklist -- --replay <replay.json> " +
    "[--output <md>] [--ledger <reviewed-ledger.json>] [--include-documentation]",
  );
  process.exit(2);
}
const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
const replay = JSON.parse(readFileSync(replayPath, "utf8"));
const registry = generateV9MissingDataRegistry({
  replay,
  policy,
  catalogEntries: loadPerCoinStablecoinEntries(),
});
const output = renderCurationWorklist(replay, registry, replayPath, {
  includeDocumentation: process.argv.includes("--include-documentation"),
  documentationGaps: collectDocumentationGaps(replay, policy),
  parkedClaimGroups: await collectParkedClaimGroups(arg("--ledger") ?? DEFAULT_LEDGER_PATH),
});
const outputPath = arg("--output");
if (outputPath) {
  writeFileSync(outputPath, output);
  console.log(`Wrote curation worklist to ${outputPath}`);
} else {
  console.log(output);
}
}
