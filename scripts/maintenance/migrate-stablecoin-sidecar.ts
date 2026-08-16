import { STABLECOIN_SOURCE_DOMAIN_VALUES, type StablecoinSourceDomain } from "@shared/lib/stablecoins/schema";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { migrateStablecoinSidecar } from "../lib/stablecoin-sidecar-workflow";

const USAGE = `Usage: npx tsx scripts/maintenance/migrate-stablecoin-sidecar.ts --domain <domain> --id <coin-id> [--id <coin-id> ...] [options]

Move an already-authored research domain from base coin JSON into strict sidecars.
The command validates projection equality before writing and never researches or changes values.

Domains:
  reserves | mint-authority | compliance | risk-review

Options:
  --domain <domain>  Sidecar domain to migrate
  --id <coin-id>     Canonical stablecoin ID; repeat for a batch
  --dry-run          Validate and print the move without writing
  --check            Require every requested ID to be fully migrated already
  -h, --help         Show this help`;

function isStablecoinSourceDomain(value: string): value is StablecoinSourceDomain {
  return (STABLECOIN_SOURCE_DOMAIN_VALUES as readonly string[]).includes(value);
}

export function parseStablecoinSidecarMigrationArgs(argv: readonly string[]): {
  check: boolean;
  domain: StablecoinSourceDomain;
  dryRun: boolean;
  help: boolean;
  ids: string[];
} {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["check", "dry-run"]],
    options: {
      domain: { type: "string" },
      id: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      check: { type: "boolean" },
    },
  });
  if (values.help === true) {
    return { check: false, domain: "reserves", dryRun: false, help: true, ids: [] };
  }

  const domain = typeof values.domain === "string" ? values.domain : "";
  const ids = Array.isArray(values.id)
    ? values.id.filter((id): id is string => typeof id === "string")
    : typeof values.id === "string"
      ? [values.id]
      : [];
  assertCliUsage(isStablecoinSourceDomain(domain), `--domain must be one of ${STABLECOIN_SOURCE_DOMAIN_VALUES.join(", ")}`);
  assertCliUsage(ids.length > 0, "Specify at least one --id");
  const validatedDomain = domain as StablecoinSourceDomain;

  return {
    check: values.check === true,
    domain: validatedDomain,
    dryRun: values["dry-run"] === true,
    help: false,
    ids,
  };
}

export function runStablecoinSidecarMigration(argv = process.argv.slice(2)): void {
  const options = parseStablecoinSidecarMigrationArgs(argv);
  if (options.help) {
    writeCliHelpIfRequested({ help: true }, USAGE);
    return;
  }

  for (const id of options.ids) {
    const result = migrateStablecoinSidecar({
      check: options.check,
      domain: options.domain,
      dryRun: options.dryRun,
      id,
    });
    const action = options.check
      ? "verified"
      : result.changed
        ? options.dryRun
          ? "would move"
          : "moved"
        : "already migrated";
    const fields = result.movedFields.length > 0 ? ` (${result.movedFields.join(", ")})` : "";
    process.stdout.write(`[stablecoin-sidecar] ${id}: ${action} ${options.domain}${fields}\n`);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runStablecoinSidecarMigration(), {
    label: "migrate-stablecoin-sidecar",
    usage: USAGE,
  });
}
