import type { DocReference } from "./doc-ownership-registry.mts";
import { type MatchedMapping, type ChangeContract, type RouteContext } from "./change-contract-routing.ts";
import { formatDocReference } from "./change-contract-common.ts";



function formatBullets(values: readonly string[], { limit = 8 }: { limit?: number } = {}): string {
  const shown = values.slice(0, limit);
  const lines = shown.map((value) => `- ${value}`);
  if (values.length > shown.length) {
    lines.push(`- ...and ${values.length - shown.length} more`);
  }
  return lines.join("\n");
}

function formatMappings(mappings: readonly MatchedMapping[]): string {
  if (mappings.length === 0) return "- No specific ownership mapping matched yet.";
  return mappings
    .map((mapping) => `- ${mapping.label} (${mapping.risk}): ${mapping.matchedFiles.slice(0, 3).join(", ")}`)
    .join("\n");
}

export function formatContract(
  contract: ChangeContract,
  { mode = "full", context }: { mode?: "full" | "stop"; context?: RouteContext } = {},
): string {
  const changedSummary =
    contract.changedFiles.length > 0
      ? formatBullets(contract.changedFiles, { limit: mode === "stop" ? 6 : Number.POSITIVE_INFINITY })
      : "- No current changed files detected.";
  const formatReading = (doc: DocReference): string => {
    const measured = context?.references.find((ref) => ref.path === doc.path && ref.anchor === doc.anchor);
    return formatDocReference(doc) + (measured
      ? ` (${measured.bytes} B, ${measured.lines} lines, ~${measured.approximateTokens} tokens; ${measured.requiredReason})`
      : "");
  };
  const sections = [
    "Pharos change contract:",
    `Source: ${contract.source}`,
    `Reading context: ${contract.contextMode.requested} → ${contract.contextMode.effective} (${contract.contextMode.reasons.join("; ")})`,
    "",
    "Matched mappings:",
    formatMappings(contract.mappings),
    "",
    "Changed files:",
    changedSummary,
    "",
    "Read first:",
    formatBullets(contract.docs.map(formatReading), { limit: mode === "stop" ? 8 : Number.POSITIVE_INFINITY }),
  ];

  if (contract.scopedContext.length > 0) {
    sections.push("", "Scoped context:", formatBullets(contract.scopedContext.map((path) => formatReading({ path })), { limit: mode === "stop" ? 6 : Number.POSITIVE_INFINITY }));
  }

  if (contract.background.length > 0) {
    sections.push("", "Also relevant:", formatBullets(contract.background.map(formatDocReference), { limit: mode === "stop" ? 6 : Number.POSITIVE_INFINITY }));
  }
  if (context) {
    const root = context.references.find((reference) => reference.kind === "root")!;
    sections.push(
      "",
      `Context budget: ${context.class} — ${context.status} (ceiling ${context.ceiling} B)`,
      `- ${formatReading(root)} (counted once)`,
      `Total initial routed context: ${context.total.bytes} B, ${context.total.lines} lines, ~${context.total.approximateTokens} tokens (merged per file).`,
      "Background references are not counted. Additional scoped-guide reads, source/tests, skills, framework guides, and route-envelope text are excluded.",
    );
    if (context.status === "over-budget") {
      sections.push(
        `Warning: over budget by ${context.total.bytes - context.ceiling} B (advisory; nothing was dropped).`,
        context.remediation!,
        "Contributions (merged per file, largest first):",
        formatBullets([...context.files].sort((a, b) => b.bytes - a.bytes).map((file) => `${file.path}: ${file.bytes} B`), { limit: Number.POSITIVE_INFINITY }),
      );
    }
  }

  if (contract.checks.length > 0) {
    sections.push(
      "",
      "Checks to consider before finalizing:",
      formatBullets(contract.checks, { limit: mode === "stop" ? 8 : Number.POSITIVE_INFINITY }),
    );
  }

  if (contract.warnings.length > 0) {
    sections.push("", "Warnings:", formatBullets(contract.warnings, { limit: mode === "stop" ? 6 : Number.POSITIVE_INFINITY }));
  }

  sections.push("", "Rules:", formatBullets(contract.hardRules, { limit: mode === "stop" ? 6 : Number.POSITIVE_INFINITY }));

  if (contract.deploy.deployImpact) {
    sections.push(
      "",
      `Deploy impact: pages=${contract.deploy.pagesImpact ? "yes" : "no"}, worker=${contract.deploy.workerImpact ? "yes" : "no"}.`,
    );
  }

  if (contract.source === "working tree") {
    sections.push("", "Next: npm run agent:route -- --file <path> for planned files");
  }

  return sections.join("\n");
}

export function buildSessionStartContext(contract: ChangeContract): string {
  const header = `Pharos change contract — ${contract.source} (${contract.changedFiles.length} files) — deploy: pages=${contract.deploy.pagesImpact ? "y" : "n"}, worker=${contract.deploy.workerImpact ? "y" : "n"}`;
  const readFirst = contract.docs
    .slice(0, 4)
    .map(formatDocReference)
    .join(", ");
  const scopedContext = contract.scopedContext
    .slice(0, 3)
    .join(", ");

  if (contract.changedFiles.length === 0) {
    return [header, "Route a planned path: npm run agent:route -- --file <path>"].join("\n");
  }

  const sections = [header, `Read first: ${readFirst}`];

  if (scopedContext) {
    sections.push(`Scoped context: ${scopedContext}`);
  }

  if (contract.checks.length > 0) {
    sections.push(`Focused checks: ${contract.checks.slice(0, 4).join(", ")}`);
  }

  sections.push("Route a planned path: npm run agent:route -- --file <path>");
  return sections.join("\n");
}

export function buildSessionStartHookOutput(contract: ChangeContract) {
  return {
    hookSpecificOutput: {
      additionalContext: buildSessionStartContext(contract),
      hookEventName: "SessionStart",
    },
  };
}