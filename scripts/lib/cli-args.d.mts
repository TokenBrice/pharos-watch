export interface CliOptionDefinition {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[] | boolean[];
}

export interface StrictCliConfig {
  allowNegativeValues?: readonly string[];
  allowPositionals?: boolean;
  conflicts?: readonly (readonly string[])[];
  options?: Record<string, CliOptionDefinition>;
}

export interface StrictCliResult {
  values: Record<string, string | boolean | string[] | boolean[] | undefined>;
  positionals: string[];
  tokens: import("node:util").ParseArgsToken[];
}

export class CliUsageError extends Error {
  readonly exitCode: 2;
}

export function parseStrictCliArgs(argv: readonly string[], config?: StrictCliConfig): StrictCliResult;
export function assertCliUsage(condition: unknown, message: string): asserts condition;
export function parseCliInteger(
  value: unknown,
  bounds: { name: string; min?: number; max?: number },
): number;
export function writeCliHelpIfRequested(
  values: { help?: unknown },
  usage: string,
  output?: { write: (text: string) => unknown },
): boolean;
export function runCliEntrypoint(
  action: () => unknown | Promise<unknown>,
  options?: {
    label?: string;
    usage?: string;
    stderr?: { write: (text: string) => unknown };
  },
): Promise<void>;
