// Generates the V9 evidence-curation worklist from a V9 replay:
// one checkbox item per (asset, workstream), ordered by supply weight, with
// the exact reason codes and paths that currently bound the asset. Agents
// walk the generated document to completion and regenerate it after each
// batch; an item disappears from the regenerated list when its codes clear.
//
// Usage:
//   node scripts/maintenance/generate-safety-score-v9-curation-worklist.mjs \
//     --replay <replay-v9.json> [--output <worklist.md>]
import { readFileSync, writeFileSync } from "node:fs";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources.ts";
import {
  classifyV9CurationWorklistStream,
  generateV9MissingDataRegistry,
} from "./generate-safety-score-v9-missing-data-registry.ts";

const STREAMS = [
  {
    key: "CTRL",
    title: "Control — mint / upgrade / control identity",
    ceiling: "control-unverified (55)",
    fix: "Resolve the asset's mintAuthority block in shared/data/stablecoins/coins/<id>.json: mint path, authority type + threshold, cap semantics, upgradeability model and controlRef, per-control evidence with sources. Mostly deterministic explorer/RPC reads (proxy admin slots, owner()/minters(), multisig thresholds); RPC endpoints and structural-blocker notes are in the mint-authority verified-campaign memory. Multichain assets need every deployment's authority graph.",
  },
  {
    key: "ORCL",
    title: "Oracle — profile and CDP branch reviews",
    ceiling: "oracle-unverified (55)",
    fix: "Populate/complete the oracleRisk block (tier, branch applicability disposition, per-branch feed/collateral-parameter/liquidation/backstop/shutdown reviews) in the coin JSON. CDP-family assets need the branch-applicability ruling; non-oracle designs need an explicit not-applicable review.",
  },
  {
    key: "BRDG",
    title: "Bridge — route reviews and supply materiality",
    ceiling: "control-unverified (55)",
    fix: "Review the runtime-selected bridge routes (bridgeRoutes rows: route kind, verification model, controls) so selected routes resolve and bridged supply matches reviewed rows. The static P7 route research queue feeds this; only runtime-selected scoring routes matter here.",
  },
  {
    key: "RESV",
    title: "Backing — reserve envelope, composition, assurance",
    ceiling: "backing-unverified (60)",
    fix: "Author or refresh the structured reserve evidence. For a missing or incomplete envelope, populate reserves[] slices with assetClass, issuerOrObligor, liquidityHorizon, maturityDaysMax, plus reserveReview, custodyProfile, and proofOfReserves.latestReport. For stale-audited-reserve-composition, refresh reserves[] and compositionAsOf from the newest independent attestation; if the issuer has not published a newer composition, record the blocker and accept the audited-fallback adequate ceiling rather than restating expired evidence. Use the reserve-research skill; envelope refresh recipes are in the V9 topic memory.",
  },
  {
    key: "MECH",
    title: "Mechanism — curated overlay for measured-ratio archetypes",
    archetypes: ["cdp", "synthetic-delta-neutral", "algorithmic", "rwa-credit-fund"],
    ceiling: "component floor boundedUnknownQuality (35)",
    fix: "Author a sourced overlay in shared/data/safety-score-v9/mechanism-review-overlays-v1.json (archetype-specific components + REQUIRED measured metrics, e.g. CDP collateralizationRatio/liquidationCapacityRatio). NO FABRICATION: only author when an honest live source exists (bold-liquity via api.liquity.org is the template). CONFIRMED BLOCKED (2026-07-13 + independently re-verified by mechanism batch 01, 2026-07-14 — do not re-research): DAI/USDS (auction Hole limits are governance caps, not committed liquidation capital; no reproducible system CR), USDe (reserve fund observable, hedge notional/margin buffers not public), USDD (vault-only CR must not be applied to total supply; non-vault issuance routes), USDf-Falcon (insurance fund observable, empty venue map, no hedge measurements), crvUSD (PegKeeper share needs decomposition), LUSD (needs on-chain TCR read — the one actionable path). Expect most of this stream to stay blocked until issuers publish ratios or on-chain readers are built.",
  },
  {
    key: "EXIT",
    title: "Exit — same-notional route evidence",
    ceiling: "exit-unverified (65)",
    fix: "Best lever per asset: (a) a resolved redemption row (redemption methodology v4.18 derives a bounded exit observation from a supply-full row with documented fixed-bps fee), (b) unresolved-exit-output routes: set `outputAssets` on the asset's entry in shared/lib/redemption-backstop-configs/ — tracked stablecoin ids for stable-single/stable-basket, canonical asset:<symbol> keys for collateral; ONLY when the documented rail names the output (config notes/docs are the source; schema validates shape), (c) exact DEX capacity where the pool archetype is supported (raydium CP, balancer weighted). Captures with producer-embedded observations pick up outputAssets on the next production capture. CL-pool exact capacity is producer tick-data work, not per-asset curation — do not grind unsupported pools by hand.",
  },
  {
    key: "PEG",
    title: "Peg — missing peg rows",
    ceiling: "peg-unverified (60)",
    fix: "Ensure the asset has a peg row (pegCurrency resolvable, price feed tracked) or a reviewed NAV/not-applicable ruling (flags.navToken for pure NAV designs). OTHER-peg assets need the peg building blocks first — check the GELT/OTHER-peg parked memory before grinding.",
  },
  {
    key: "DEP",
    title: "Dependencies — unreviewed relationship sets",
    ceiling: "evidence:limited (69)",
    fix: "Review the effective dependency set (collateral mapping to reserve exposures must be exact; serial wrapper/mechanism edges explicit). material-dependency-unavailable clears when the upstream asset becomes rateable — check the upstream first.",
  },
  {
    key: "ARCH",
    title: "Archetype — unresolved classification (hard NR)",
    ceiling: "NR (stays-NR set)",
    fix: "Assign a mechanism archetype (resolve-mechanism-archetype path / resilience-classify skill). These are the only assets NR by classification; everything else in this file is score-improvement, not rateability.",
  },
];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const replayPath = arg("--replay");
if (!replayPath) {
  console.error("Usage: generate-safety-score-v9-curation-worklist.mjs --replay <replay.json> [--output <md>]");
  process.exit(2);
}
const replay = JSON.parse(readFileSync(replayPath, "utf8"));
const registry = generateV9MissingDataRegistry({
  replay,
  policy: JSON.parse(
    readFileSync(new URL("../../shared/data/safety-score-v9/methodology-policy-candidate-v1.json", import.meta.url), "utf8"),
  ),
  catalogEntries: loadPerCoinStablecoinEntries(),
});
const cards = replay.pipeline.candidate.cards;
if (registry.summary.stablecoinCount !== cards.length) {
  throw new Error("Typed missing-data registry and replay card counts differ");
}
const assets = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));

function money(value) {
  if (!value) return "$0";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value / 1e3)}k`;
}

const items = new Map(); // `${stream}:${assetId}` -> { codes: Map(code -> Set(path)) }
function addItem(streamKey, assetId, code, path) {
  const key = `${streamKey}:${assetId}`;
  const item = items.get(key) ?? { streamKey, assetId, codes: new Map() };
  const paths = item.codes.get(code) ?? new Set();
  if (path) paths.add(path);
  item.codes.set(code, paths);
  items.set(key, item);
}

for (const card of cards) {
  const asset = assets.get(card.id);
  const lanes = [
    ...["backing", "exit", "control"].flatMap((pillar) => asset.scoreInput.pillars[pillar].reasons),
    ...asset.scoreInput.peg.reasons,
    ...asset.scoreInput.dependencyReasons,
  ];
  for (const reason of lanes) {
    const streamKey = classifyV9CurationWorklistStream(reason.code);
    if (streamKey) addItem(streamKey, card.id, reason.code, reason.path);
  }
  for (const reason of card.nrReasons ?? []) {
    const streamKey = classifyV9CurationWorklistStream(reason.code);
    if (streamKey) addItem(streamKey, card.id, reason.code, reason.field ?? null);
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

const supplyOf = (assetId) => assets.get(assetId)?.stressState?.exitPortfolio?.circulatingUsd ?? 0;
const priority = (supply) => (supply >= 1e9 ? "P0" : supply >= 1e8 ? "P1" : supply >= 1e7 ? "P2" : "P3");

const lines = [];
lines.push("# V9 evidence-curation worklist (generated — do not hand-edit rows)");
lines.push("");
lines.push(`Generated from \`${replayPath.split("/").pop()}\` (${cards.length} cards, ` +
  `${cards.filter((card) => card.grade !== "NR").length} rateable). ` +
  "Regenerate after every merged batch:");
lines.push("");
lines.push("```bash");
lines.push("# 0. npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts  # generated catalog aggregate is gitignored and goes stale against coin edits");
lines.push("# 1. fresh exact capture + replay");
lines.push("# 2. node scripts/maintenance/generate-safety-score-v9-curation-worklist.mjs --replay <replay.json> --output <this file>");
lines.push("```");
lines.push("");
lines.push("## Protocol for agents");
lines.push("");
lines.push("1. **Claim** a contiguous block of unchecked items (top of a stream, P0 first) in the swarm session log (`results/curation-swarm-session-*.md`), and **check prior batch reports first**: an item another batch recorded as an evidence blocker must not be re-ground — carry the blocker forward instead.");
lines.push("2. **Ownership**: re-check `git status` on the target coin file immediately before editing; skip any file dirty from another lane and record the skip. Skipped-by-collision items are NOT done — the coordinator sweeps them into a later batch.");
lines.push("3. **Fix** per the stream's how-to. Evidence must be sourced and cited (primary sources, review date, reviewer); NO fabricated values, NO manual supply overrides. If a source doesn't exist, record `BLOCKED(<why>)` in your batch report — dead ends are findings, and refusing to author is the correct outcome (see the MECH stream).");
lines.push("4. **Verify** locally: per-file schema parse for touched records + focused vitest suites. Expect `check:stablecoin-data` to report stale generated artifacts mid-batch — that is by design; do NOT regenerate registry/generated artifacts during a parallel batch (coordinator/measurement time only).");
lines.push("5. **Commit** in thematic batches after the coordinator reviews the combined diff (descriptive subject + body).");
lines.push("6. **Re-measure** (coordinator, periodically — not per item): registry regen → fresh replay → regenerate this file. Items whose codes cleared disappear; never hand-edit generated rows.");
lines.push("");
lines.push("Item ID format: `STREAM-assetId`. An item is DONE when none of its listed reason codes appear for the asset in a fresh replay.");
lines.push("");
lines.push("**Where to spend hours** (measured 2026-07-14): CTRL, RESV, ORCL, and BRDG batches clear items reliably and CTRL is the biggest single-score lever (~8-12 pts per asset). MECH is mostly an evidence wall (5/5 majors blocked on unpublishable ratios) — do not grind it; it moves via on-chain reads or issuer transparency changes. EXIT largely waits on the next deploy+capture (embedded producer observations) plus `outputAssets` config curation.");
lines.push("");

lines.push("## Summary");
lines.push("");
lines.push("| Stream | Items | Ceiling released |");
lines.push("|---|---|---|");
for (const stream of STREAMS) {
  const count = [...items.values()].filter((item) => item.streamKey === stream.key).length;
  lines.push(`| ${stream.key} | ${count} | ${stream.ceiling} |`);
}
lines.push(`| **Total** | **${items.size}** | |`);
lines.push("");

for (const stream of STREAMS) {
  const streamItems = [...items.values()]
    .filter((item) => item.streamKey === stream.key)
    .sort((left, right) => supplyOf(right.assetId) - supplyOf(left.assetId));
  lines.push(`## ${stream.key} — ${stream.title} (${streamItems.length})`);
  lines.push("");
  lines.push(`**Releases:** ${stream.ceiling}. **How to fix:** ${stream.fix}`);
  lines.push("");
  if (streamItems.length === 0) {
    lines.push("_No open items._");
    lines.push("");
    continue;
  }
  lines.push("| ☐ | ID | Pri | Supply | V9 | Codes (paths) |");
  lines.push("|---|---|---|---|---|---|");
  for (const item of streamItems) {
    const supply = supplyOf(item.assetId);
    const card = cards.find((entry) => entry.id === item.assetId);
    const codes = [...item.codes.entries()]
      .map(([code, paths]) => {
        const list = [...paths].slice(0, 4).join(", ");
        const extra = paths.size > 4 ? ` +${paths.size - 4}` : "";
        return paths.size > 0 ? `${code} (${list}${extra})` : code;
      })
      .join("; ");
    lines.push(
      `| ☐ | ${stream.key}-${item.assetId} | ${priority(supply)} | ${money(supply)} | ` +
        `${card.grade}/${card.score ?? "—"} | ${codes} |`,
    );
  }
  lines.push("");
}

const output = lines.join("\n");
const outputPath = arg("--output");
if (outputPath) {
  writeFileSync(outputPath, output);
  console.log(`Wrote ${items.size} items to ${outputPath}`);
} else {
  console.log(output);
}
