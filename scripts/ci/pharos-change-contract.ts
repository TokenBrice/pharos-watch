#!/usr/bin/env node
import type * as FocusedChecks from "../maintenance/run-focused-checks.ts";
import { CliUsageError, parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { type RouteContextDocumentCache, type ChangeSource, normalizeExplicitFiles, readChangedFiles, ExplicitPathError, classifyChangedFilesWithSource, buildRouteContext } from "../lib/change-contract-routing.ts";
import { readHookInput, type HookViolation, withHookRule, appendHookDiagnostic, type HookMode, buildPermissionRequestDenyOutput, buildToolDenyOutput, findPreToolUseViolation, findPermissionRequestViolation } from "../lib/change-contract-hooks.ts";
import { buildSessionStartHookOutput, formatContract } from "../lib/change-contract-render.ts";
import { require } from "../lib/change-contract-common.ts";
export { type ChangeContract, ROUTE_CONTEXT_CEILINGS, type RouteClass, classifyRouteContext, normalizeChangedFiles, normalizeExplicitFiles, classifyChangedFiles, type RouteContext, type RouteContextDocumentCache, buildRouteContext, readChangedFiles } from "../lib/change-contract-routing.ts";
export { findShellCommandViolation, findPreToolUseViolation, findPermissionRequestViolation, type HookInputResult, type HookInputDeps, getHookHarness, readHookInput, buildPreToolUseHookOutput, buildPermissionRequestHookOutput } from "../lib/change-contract-hooks.ts";
export { formatContract, buildSessionStartContext, buildSessionStartHookOutput } from "../lib/change-contract-render.ts";



interface CliOptions {
  allowMissing: boolean;
  baseRef?: string;
  diagnostics: boolean;
  context: "auto" | "contract";
  format: "json" | "text";
  headRef?: string;
  help: boolean;
  hook: string | null;
  staged: boolean;
}

function parseArgs(argv: readonly string[]): { explicitFiles: string[]; options: CliOptions } {
  const { values } = parseStrictCliArgs(argv, { conflicts: [["base", "base-ref"], ["head", "head-ref"]], options: {
    json: { type: "boolean" },
    diagnostics: { type: "boolean" },
    context: { type: "string" },
    "new-file": { type: "boolean", multiple: true },
    staged: { type: "boolean" },
    hook: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    "base-ref": { type: "string" },
    "head-ref": { type: "string" },
    file: { type: "string", multiple: true },
  } });
  const hook = normalizeHookMode(typeof values.hook === "string" ? values.hook : null);
  if (hook && !["session-start", "pre-tool-use", "permission-request"].includes(hook)) {
    throw new CliUsageError(`Unknown hook mode: ${hook}`);
  }
  const context = values.context ?? "auto";
  if (context !== "auto" && context !== "contract") throw new CliUsageError(`Invalid --context: ${context}; expected auto or contract`);
  return {
    explicitFiles: (values.file ?? []) as string[],
    options: {
      allowMissing: Array.isArray(values["new-file"]) && values["new-file"].some(Boolean),
      context,
      baseRef: (values.base ?? values["base-ref"]) as string | undefined ?? process.env.PHAROS_CHANGE_CONTRACT_BASE_REF,
      headRef: (values.head ?? values["head-ref"]) as string | undefined ?? process.env.PHAROS_CHANGE_CONTRACT_HEAD_REF,
      diagnostics: values.diagnostics === true,
      format: values.json === true ? "json" : "text",
      help: values.help === true,
      hook,
      staged: values.staged === true,
    },
  };
}

function normalizeHookMode(hook: string | null): string | null {
  if (!hook) return null;
  const normalized = String(hook)
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return normalized;
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/ci/pharos-change-contract.ts [options]

Classify the current Pharos diff into docs, checks, and agent guardrails.

Options:
  --json                  Emit the contract as JSON instead of text
  --context=auto|contract  Select reading context (default auto; local is internal only)
  --diagnostics            Append safe per-hook diagnostics when a hook is selected
  --staged                Classify staged files only
  --new-file              Suppress missing explicit-file warnings (repeatable)
  --base, --base-ref <ref> Classify git diff base...head
  --head, --head-ref <ref> Classify git diff base...head
  --file <path>           Classify an explicit file path; repeatable
  --hook=session-start    Emit compact SessionStart hook JSON
  --hook=pre-tool-use     Emit hard-block hook JSON for unsafe tool calls
  --hook=permission-request
                          Emit production permission-policy hook JSON
`);
}

export interface RunCliDeps {
  readStdin?: () => string;
  /** Reuse one immutable Markdown snapshot when a caller runs several routes in one process. */
  documents?: RouteContextDocumentCache;
}

export function runCli(argv: readonly string[] = process.argv.slice(2), deps: RunCliDeps = {}): void {
  const { explicitFiles, options } = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const hookRead = options.hook ? readHookInput(deps) : { input: {}, malformed: false };
  const hookMode = normalizeHookMode(options.hook);

  if (options.hook && hookRead.malformed) {
    const malformedViolation: HookViolation = {
      reason: withHookRule(
        "malformed-hook-input",
        "Hook payload was empty or malformed, so no policy could be applied. Enforcement modes deny by default; retry with a well-formed payload.",
      ),
      rule: "malformed-hook-input",
    };
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(hookMode as HookMode, {}, malformedViolation, true);
    }
    if (hookMode === "session-start") {
      console.error("pharos-change-contract: empty or malformed hook payload; no policy applied");
      console.log(JSON.stringify({}));
      return;
    }
    console.error(`pharos-change-contract: ${malformedViolation.reason}`);
    console.log(JSON.stringify(
      hookMode === "permission-request"
        ? buildPermissionRequestDenyOutput(malformedViolation.reason)
        : buildToolDenyOutput(malformedViolation.reason, "PreToolUse"),
    ));
    process.exitCode = 2;
    return;
  }

  const hookInput = hookRead.input;

  if (hookMode === "pre-tool-use") {
    const violation = findPreToolUseViolation(hookInput);
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(hookMode, hookInput, violation, false);
    }
    console.log(JSON.stringify(violation ? buildToolDenyOutput(violation.reason, "PreToolUse") : {}));
    return;
  }

  if (hookMode === "permission-request") {
    const violation = findPermissionRequestViolation(hookInput);
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(hookMode, hookInput, violation, false);
    }
    console.log(JSON.stringify(violation ? buildPermissionRequestDenyOutput(violation.reason) : {}));
    return;
  }

  let changedFiles: string[];
  let source: ChangeSource;
  try {
    if (explicitFiles.length > 0) {
      source = "explicit files";
      changedFiles = normalizeExplicitFiles(explicitFiles, { allowMissing: options.allowMissing });
    } else if (options.staged) {
      source = "staged index";
      changedFiles = readChangedFiles({
        baseRef: options.baseRef,
        headRef: options.headRef,
        staged: true,
      });
    } else if (options.baseRef || options.headRef) {
      source = "base/head range";
      changedFiles = readChangedFiles({
        baseRef: options.baseRef,
        headRef: options.headRef,
        staged: false,
      });
    } else {
      source = "working tree";
      changedFiles = readChangedFiles({ staged: false });
    }
  } catch (error) {
    if (hookMode === "session-start" && !(error instanceof ExplicitPathError)) {
      const message = "Pharos change selection unavailable; run agent:route with explicit files before editing.";
      console.error(message);
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } }));
      return;
    }
    if (error instanceof ExplicitPathError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const contract = classifyChangedFilesWithSource(changedFiles, source, options.context);
  if (contract.unmappedPaths.length > 0) process.exitCode = 1;

  if (hookMode === "session-start") {
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(hookMode, hookInput, null, false);
    }
    console.log(JSON.stringify(buildSessionStartHookOutput(contract)));
    return;
  }
  const { buildFocusedCheckPlan } = require("../maintenance/run-focused-checks.ts") as typeof FocusedChecks;
  contract.checks = buildFocusedCheckPlan(changedFiles).checks.map((check) => check.command);
  if (contract.unmappedPaths.length > 0) {
    contract.checks = [];
    process.exitCode = 1;
  }
  const context = buildRouteContext(contract, deps.documents ? { documents: deps.documents } : {});
  if (options.format === "json") {
    console.log(JSON.stringify({ ...contract, context }, null, 2));
    return;
  }

  console.log(formatContract(contract, { context }));
}

runDirectCli(import.meta.url, () => runCli(), { label: "pharos-change-contract" });