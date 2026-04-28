import type {
  EnvBindingDefinition,
  EnvRuntimeName,
} from "./types";
import { ENV_BINDINGS } from "./registry";

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function renderMarkdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`),
  ].join("\n");
}

function renderRuntimeStatus(
  binding: EnvBindingDefinition,
  runtime: Exclude<EnvRuntimeName, "frontend">,
): string {
  return binding.runtimes[runtime]?.status ?? "-";
}

export function renderWorkerInfrastructureEnvBlock(): string {
  const rows = ENV_BINDINGS
    .filter((binding) => binding.runtimes.worker || binding.runtimes.pagesOps || binding.runtimes.pagesSiteData)
    .map((binding) => [
      `\`${binding.key}\``,
      `\`${binding.valueType}\``,
      renderRuntimeStatus(binding, "worker"),
      renderRuntimeStatus(binding, "pagesOps"),
      renderRuntimeStatus(binding, "pagesSiteData"),
      binding.description,
    ] as const);

  return [
    "Canonical binding ownership now lives in `shared/lib/env-contract.ts`; the worker and Pages env modules derive their `required` / `optional` / `reserved` views from that manifest.",
    "",
    renderMarkdownTable(
      ["Binding", "Type", "Worker", "Pages ops", "Pages site-data", "Description"],
      rows,
    ),
  ].join("\n");
}

export function renderOperatorOriginAccessEnvBlock(): string {
  const rows = ENV_BINDINGS
    .filter((binding) => binding.docs?.includeInOperatorOriginAccess)
    .map((binding) => [
      `\`${binding.key}\``,
      renderRuntimeStatus(binding, "worker"),
      renderRuntimeStatus(binding, "pagesOps"),
      renderRuntimeStatus(binding, "pagesSiteData"),
      binding.description,
    ] as const);

  return [
    "Current origin/access binding ownership derived from `shared/lib/env-contract.ts`:",
    "",
    renderMarkdownTable(
      ["Binding", "Worker", "Pages ops", "Pages site-data", "Purpose"],
      rows,
    ),
  ].join("\n");
}
