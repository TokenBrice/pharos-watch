#!/usr/bin/env tsx

import { buildDependencyGraphEdges } from "@shared/lib/dependency-graph";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CliUsageError, parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { readRequiredJsonFile, isRecord, writeOutputFile } from "../lib/coverage-audit-cli";
import { renderMarkdownRows } from "../lib/markdown-report";
import {
  DependencyCoverageProvenanceSchema, readDependencyCheckoutRevision,
  type DependencyCoverageAudit, type DependencyPublicationProvenance,
} from "./generate-dependency-coverage-audit";

type Edge = { from: string; to: string; kind: "basket" | "serial"; weight: number | null };
export interface DependencyGraphReconciliation {
  generatedAt: string;
  provenance: {
    publication: DependencyPublicationProvenance | null;
    auditCheckoutRevision: string | null;
    checkoutRevision: string | null;
    publicationComparisonStatus: DependencyCoverageAudit["summary"]["publicationComparisonStatus"] | null;
  };
  counts: { static: number; published: number; staticOnly: number; publishedOnly: number; weightDiff: number };
  staticOnly: Edge[];
  publishedOnly: Edge[];
  weightDiff: Array<Edge & { publishedWeight: number | null }>;
}
const key = (edge: Edge): string => `${edge.from}->${edge.to}:${edge.kind}`;

/** Differences are advisory; edge kind is part of identity, not a weight change. */
export function reconcileDependencyGraph(
  audit: DependencyCoverageAudit,
  checkoutRevision: string | null = readDependencyCheckoutRevision(),
): DependencyGraphReconciliation {
  if (audit.reportCardGraph == null) throw new Error("Reconciliation requires a published dependency-coverage capture.");
  const provenance = audit.provenance == null
    ? { publication: null, checkoutRevision: null }
    : DependencyCoverageProvenanceSchema.parse(audit.provenance);
  const comparisonStatus = audit.summary?.publicationComparisonStatus ?? null;
  if (comparisonStatus !== null && !["not-evaluated", "matched", "checkout-production-skew"].includes(comparisonStatus)) {
    throw new Error("Invalid publication comparison status in dependency-coverage capture.");
  }
  const currentCheckout = DependencyCoverageProvenanceSchema.shape.checkoutRevision.parse(checkoutRevision);
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
  return { generatedAt: audit.generatedAt,
    provenance: {
      publication: provenance.publication,
      auditCheckoutRevision: provenance.checkoutRevision,
      checkoutRevision: currentCheckout,
      publicationComparisonStatus: comparisonStatus,
    },
    counts: { static: staticEdges.length, published: publishedEdges.length,
      staticOnly: staticOnly.length, publishedOnly: publishedOnly.length, weightDiff: weightDiff.length },
    staticOnly, publishedOnly, weightDiff };
}

export function renderDependencyGraphReconciliationMarkdown(report: DependencyGraphReconciliation): string {
  const table = (rows: Edge[]) => renderMarkdownRows({ headings: ["upstream", "dependent", "kind", "weight"], rows,
    cells: (edge) => [edge.from, edge.to, edge.kind, edge.weight ?? "unknown / serial"] });
  const publication = report.provenance.publication;
  return ["# Dependency Graph Reconciliation", "",
    `Audit capture: ${report.generatedAt}.`,
    `Audit checkout revision: ${report.provenance.auditCheckoutRevision ?? "unknown / legacy capture"}.`,
    `Static comparison checkout revision: ${report.provenance.checkoutRevision ?? "unknown"}.`,
    `Publication comparison status at capture: ${report.provenance.publicationComparisonStatus ?? "unknown / legacy capture"}.`,
    publication
      ? `Publication identity: \`${JSON.stringify(publication.safetyScoreIdentity)}\`. As of: ${publication.asOfSec}; updated: ${publication.updatedAt}; health: ${publication.publicationHealth.status}.`
      : "Publication identity and clocks: unknown / legacy capture.",
    publication ? `Publication source: \`${JSON.stringify(publication.source)}\`.` : "Publication source generations: unknown / legacy capture.",
    "",
    "Advisory differences only; no automatic edge admission or release decision. Publication, audit capture and checkout are independent: an older or held publication can differ legitimately from newer authored metadata.", "",
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
  const output = values.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderDependencyGraphReconciliationMarkdown(report);
  if (typeof values.report === "string") writeOutputFile(values.report, output);
  else process.stdout.write(output);
});
