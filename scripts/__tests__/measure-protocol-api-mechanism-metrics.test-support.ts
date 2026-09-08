import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const script = resolve("scripts/maintenance/measure-protocol-api-mechanism-metrics.ts");
const loader = import.meta.resolve("tsx");

export function runProtocolCli(args: readonly string[], cwd: string) {
  const env = { ...process.env };
  env.TSX_TSCONFIG_PATH = resolve("tsconfig.json");
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.R2_MEASUREMENTS_ACCESS_KEY_ID;
  delete env.R2_MEASUREMENTS_SECRET_ACCESS_KEY;
  return spawnSync(process.execPath, ["--import", loader, script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}
