#!/usr/bin/env tsx

import { buildDependencyGraphEdges } from "@shared/lib/dependency-graph";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CliUsageError, parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { readRequiredJsonFile, isRecord, writeOutputFile } from "../lib/coverage-audit-cli";
import { renderMarkdownRows } from "../lib/markdown-report";
import type { DependencyCoverageAudit } from "./generate-dependency-coverage-audit";

type Edge = { from: string; to: string; kind: "basket" | "serial"; weight: number | null };
export interface DependencyGraphReconciliation {
  generatedAt: string;
  counts: { static: number; published: number; staticOnly: number; publishedOnly: number; weightDiff: number };
  staticOnly: Edge[];
  publishedOnly: Edge[];
  weightDiff: Array<Edge & { publishedWeight: number | null }>;
}
const key = (edge: Edge): string => `${edge.from}->${edge.to}:${edge.kind}`;

/** Differences are advisory; edge kind is part of identity, not a weight change. */
export function reconcileDependencyGraph(audit: DependencyCoverageAudit): DependencyGraphReconciliation {
  if (audit.reportCardGraph == null) throw new Error("Reconciliation requires a published dependency-coverage capture.");
  const staticEdges: Edge[] = buildDependencyGraphEdges(ACTIVE_STABLECOINS).map((edge) => ({
    from: edge.from, to: edge.to, kind: edge.type === "collateral" ? "basket" : "serial",
    weight: edge.type === "collateral" ? edge.weight : null,
  }));
  const publishedEdges: Edge[] = audit.dependencyEdges.map((edge) => {
    if (edge.graphSource !== "report-card" || edge.reportKind == null) {
      throw new Error("Capture contains a non-published edge.");
    }
    return { from: edge.from, to: edge.to, kind: edge.reportKind, weight: edge.reportedWeight };
  });
  const staticByKey = new Map(staticEdges.map((edge) => [key(edge), edge]));
  const publishedByKey = new Map(publishedEdges.map((edge) => [key(edge), edge]));
  const order = (a: Edge, b: Edge): number => key(a).localeCompare(key(b));
  const staticOnly = staticEdges.filter((edge) => !publishedByKey.has(key(edge))).sort(order);
  const publishedOnly = publishedEdges.filter((edge) => !staticByKey.has(key(edge))).sort(order);
  const weightDiff = staticEdges.flatMap((edge) => {
    const published = publishedByKey.get(key(edge));
    if (!published || edge.kind !== "basket") return [];
    if (edge.weight === published.weight || (edge.weight != null && published.weight != null
      && Math.abs(edge.weight - published.weight) <= 1e-12)) return [];
    return [{ ...edge, publishedWeight: published.weight }];
  }).sort(order);
  return { generatedAt: audit.generatedAt, counts: { static: staticEdges.length, published: publishedEdges.length,
    staticOnly: staticOnly.length, publishedOnly: publishedOnly.length, weightDiff: weightDiff.length },
    staticOnly, publishedOnly, weightDiff };
}

function renderMarkdown(report: DependencyGraphReconciliation): string {
  const table = (rows: Edge[]) => renderMarkdownRows({ headings: ["upstream", "dependent", "kind", "weight"], rows,
    cells: (edge) => [edge.from, edge.to, edge.kind, edge.weight ?? "unknown / serial"] });
  return ["# Dependency Graph Reconciliation", "", `Capture: ${report.generatedAt}. Static graph: current checkout.`, "",
    "Advisory differences only. Live reserve weights and publication timing can differ from authored metadata.", "",
    "## Static-only", "", ...table(report.staticOnly), "", "## Published-only", "", ...table(report.publishedOnly), "",
    "## Weight differences", "", ...renderMarkdownRows({ headings: ["upstream", "dependent", "static weight", "published weight"],
      rows: report.weightDiff, cells: (edge) => [edge.from, edge.to, edge.weight, edge.publishedWeight ?? "unknown"] }), ""].join("\n");
}

runDirectCli(import.meta.url, () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    audit: { type: "string" }, report: { type: "string" }, format: { type: "string", default: "markdown" },
  } });
  if (values.help) {
    process.stdout.write("Usage: npm run audit:dependency-reconcile -- --audit <audit.json> [--report <path>] [--format markdown|json]\n");
    return;
  }
  if (typeof values.audit !== "string") throw new CliUsageError("--audit requires a dependency-coverage JSON capture");
  if (values.format !== "markdown" && values.format !== "json") throw new CliUsageError("--format must be markdown or json");
  const input = readRequiredJsonFile(values.audit, "--audit");
  if (!isRecord(input) || !Array.isArray(input.dependencyEdges) || !isRecord(input.reportCardGraph)
    || typeof input.generatedAt !== "string") throw new Error("Invalid dependency-coverage capture.");
  const report = reconcileDependencyGraph(input as unknown as DependencyCoverageAudit);
  const output = values.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  if (typeof values.report === "string") writeOutputFile(values.report, output);
  else process.stdout.write(output);
});
