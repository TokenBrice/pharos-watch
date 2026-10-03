#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { CliUsageError, parseStrictCliArgs, runDirectCli } from "../../scripts/lib/cli-args.mjs";
import { getReserveAdapter } from "../src/cron/reserve-adapters/index";
import { selectConfigRecoveryTargets } from "../src/lib/live-reserves/config-recovery-targets";

runDirectCli(import.meta.url, () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { base: { type: "string" } } });
  if (values.help) {
    process.stdout.write("Usage: npm run audit:live-reserve-config-changes -- --base <deployed-ref-or-pr-merge-base>\nRead-only/offline: compare semantic fingerprints to the working tree and assert targeted recovery fetcher coverage.\n");
    return;
  }
  if (typeof values.base !== "string") throw new CliUsageError("--base is required; no implicit HEAD/parent baseline");
  const base = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`], { encoding: "utf8" }).trim();
  const paths = execFileSync("git", ["diff", "--name-only", base, "--", "shared/data/stablecoins/coins"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const activeIds = new Set(ACTIVE_STABLECOINS.map((coin) => coin.id));
  const previous = new Map<string, string | null>();
  const current = new Map<string, string>();
  const configs = new Map<string, LiveReservesConfig>();
  for (const path of paths) {
    if (!path.endsWith(".json")) continue;
    const id = path.split("/").pop()!.slice(0, -5);
    if (!activeIds.has(id)) continue;
    const coin = JSON.parse(readFileSync(path, "utf8")) as { liveReservesConfig?: LiveReservesConfig };
    const config = coin.liveReservesConfig;
    if (!config || config.suspended) continue;
    configs.set(id, config);
    current.set(id, computeLiveReserveConfigFingerprint(config));
    const existed = execFileSync("git", ["ls-tree", "--name-only", base, "--", path], { encoding: "utf8" }).trim();
    if (!existed) continue;
    const oldCoin = JSON.parse(execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8" })) as { liveReservesConfig?: LiveReservesConfig };
    if (oldCoin.liveReservesConfig && !oldCoin.liveReservesConfig.suspended) {
      previous.set(id, computeLiveReserveConfigFingerprint(oldCoin.liveReservesConfig));
    }
  }
  const { targets, missingFetcherIds } = selectConfigRecoveryTargets(previous, current, (id) => getReserveAdapter(configs.get(id)!.adapter) != null);
  if (missingFetcherIds.length > 0) {
    throw new Error(`Live reserve config recovery has no registered fetcher for ${missingFetcherIds.join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify({ base, recoveryCovered: true, changedCoins: targets.map((id) => ({ id, previousFingerprint: previous.get(id), currentFingerprint: current.get(id) })) }, null, 2)}\n`);
});
