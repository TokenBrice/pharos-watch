import {
  assertCliUsage,
  parseStrictCliArgs,
  type CliOptionDefinition,
  type StrictCliResult,
} from "../../../scripts/lib/cli-args.mjs";

export interface DestructiveOperationMode {
  dryRun: boolean;
  remote: boolean;
  targetFlag: "--local" | "--remote";
}

interface DestructiveOperationOptions {
  argv: string[];
  cliOptions?: Record<string, CliOptionDefinition>;
  conflicts?: readonly (readonly string[])[];
  defaultTarget?: "--local" | "--remote";
  executeAliases?: string[];
  executeAsDryRunWhen?: (values: StrictCliResult["values"]) => boolean;
  localAllowed?: boolean;
  scriptName: string;
}

export interface ParsedDestructiveOperationArgs {
  mode: DestructiveOperationMode;
  positionals: StrictCliResult["positionals"];
  values: StrictCliResult["values"];
}

function optionName(flag: string): string {
  return flag.startsWith("--") ? flag.slice(2) : flag;
}

export function parseDestructiveOperationArgs({
  argv,
  cliOptions = {},
  conflicts = [],
  defaultTarget = "--local",
  executeAliases = [],
  executeAsDryRunWhen,
  localAllowed = true,
  scriptName,
}: DestructiveOperationOptions): ParsedDestructiveOperationArgs {
  const executeFlags = ["--execute", ...executeAliases];
  const executeOptionNames = executeFlags.map(optionName);
  const { positionals, values } = parseStrictCliArgs(argv, {
    conflicts,
    options: {
      execute: { type: "boolean" },
      "dry-run": { type: "boolean" },
      local: { type: "boolean" },
      remote: { type: "boolean" },
      confirm: { type: "string" },
      ...Object.fromEntries(executeAliases.map((flag) => [optionName(flag), { type: "boolean" as const }])),
      ...cliOptions,
    },
  });
  const selectedExecuteOptions = executeOptionNames.filter((name) => values[name] === true);
  assertCliUsage(
    selectedExecuteOptions.length <= 1,
    `Refusing ${scriptName}: ${executeFlags.join(" and ")} are mutually exclusive`,
  );
  const execute = selectedExecuteOptions.length === 1 && !executeAsDryRunWhen?.(values);
  const explicitDryRun = values["dry-run"] === true;
  const local = values.local === true;
  const explicitRemote = values.remote === true;
  const remote = explicitRemote || (!local && defaultTarget === "--remote");

  if (values.help === true) {
    return {
      mode: {
        dryRun: true,
        remote,
        targetFlag: remote ? "--remote" : "--local",
      },
      positionals,
      values,
    };
  }

  assertCliUsage(
    !(execute && explicitDryRun),
    `Refusing ${scriptName}: --execute and --dry-run are mutually exclusive`,
  );
  assertCliUsage(!(local && remote), `Refusing ${scriptName}: --local and --remote are mutually exclusive`);
  assertCliUsage(
    !(local && !localAllowed),
    `Refusing ${scriptName}: --local is not supported for this operation`,
  );

  if (execute) {
    const confirmation = typeof values.confirm === "string" ? values.confirm : null;
    const executeUsage = executeAliases.length > 0 ? `--execute (or ${executeAliases.join(" / ")})` : "--execute";
    assertCliUsage(
      confirmation === scriptName,
      `Refusing ${scriptName}: live mutation requires ${executeUsage} --confirm ${scriptName}`,
    );
  }

  return {
    mode: {
      dryRun: !execute,
      remote,
      targetFlag: remote ? "--remote" : "--local",
    },
    positionals,
    values,
  };
}

export function parseDestructiveOperationMode(options: DestructiveOperationOptions): DestructiveOperationMode {
  return parseDestructiveOperationArgs(options).mode;
}

export function describeDestructiveOperationMode(mode: DestructiveOperationMode): string {
  const mutationMode = mode.dryRun ? "DRY RUN" : "LIVE";
  const d1Target = mode.remote ? "remote D1" : "local D1";
  return `${mutationMode} (${d1Target})`;
}
