export interface DestructiveOperationMode {
  dryRun: boolean;
  remote: boolean;
  targetFlag: "--local" | "--remote";
}

interface DestructiveOperationOptions {
  argv: string[];
  scriptName: string;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function readValue(argv: string[], flag: string): string | null {
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);

  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : null;
}

export function parseDestructiveOperationMode({
  argv,
  scriptName,
}: DestructiveOperationOptions): DestructiveOperationMode {
  const execute = hasFlag(argv, "--execute");
  const explicitDryRun = hasFlag(argv, "--dry-run");
  const local = hasFlag(argv, "--local");
  const remote = hasFlag(argv, "--remote");

  if (execute && explicitDryRun) {
    throw new Error(`Refusing ${scriptName}: --execute and --dry-run are mutually exclusive`);
  }
  if (local && remote) {
    throw new Error(`Refusing ${scriptName}: --local and --remote are mutually exclusive`);
  }

  if (execute) {
    const confirmation = readValue(argv, "--confirm");
    if (confirmation !== scriptName) {
      throw new Error(`Refusing ${scriptName}: live mutation requires --execute --confirm ${scriptName}`);
    }
  }

  return {
    dryRun: !execute,
    remote,
    targetFlag: remote ? "--remote" : "--local",
  };
}

export function describeDestructiveOperationMode(mode: DestructiveOperationMode): string {
  const mutationMode = mode.dryRun ? "DRY RUN" : "LIVE";
  const d1Target = mode.remote ? "remote D1" : "local D1";
  return `${mutationMode} (${d1Target})`;
}
