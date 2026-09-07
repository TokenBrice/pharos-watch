import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE_STABLECOINS, FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { fingerprintReportCardRegistryRows } from "../../../scripts/lib/report-card-registry-fingerprint";
import transferReviewOverlaysAsset from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import { SafetyScoreV9ReviewedTransferFileSchema, type SafetyScoreV9ReviewedTransferFact } from "@shared/types/safety-score-v9-transfer-overlays";
import { computeSafetyScoreV9ReviewedTransferFactsDigest } from "../../src/lib/safety-score-v9/extension-transfer";

export interface SafetyScoreV9RegistrySnapshot {
  fingerprint: string;
  activeStablecoins: typeof ACTIVE_STABLECOINS;
  frozenStablecoins: typeof FROZEN_STABLECOINS;
  deadStablecoins: typeof DEAD_STABLECOINS;
  transferReviews: SafetyScoreV9ReviewedTransferFact[];
  transferReviewsDigest: string;
}

export function registrySnapshotFingerprint(snapshot: Pick<SafetyScoreV9RegistrySnapshot, "activeStablecoins" | "frozenStablecoins" | "deadStablecoins">): string {
  return fingerprintReportCardRegistryRows(snapshot);
}

export function verifyRegistrySnapshot(snapshot: SafetyScoreV9RegistrySnapshot): SafetyScoreV9RegistrySnapshot {
  if (registrySnapshotFingerprint(snapshot) !== snapshot.fingerprint) {
    throw new Error("Replay registry snapshot fingerprint does not match its rows");
  }
  if (computeSafetyScoreV9ReviewedTransferFactsDigest(snapshot.transferReviews) !== snapshot.transferReviewsDigest) {
    throw new Error("Replay transfer review snapshot digest does not match its rows");
  }
  return snapshot;
}

export function localRegistrySnapshot(): SafetyScoreV9RegistrySnapshot {
  const rows = { activeStablecoins: ACTIVE_STABLECOINS, frozenStablecoins: FROZEN_STABLECOINS, deadStablecoins: DEAD_STABLECOINS };
  const transferReviews = SafetyScoreV9ReviewedTransferFileSchema.parse(transferReviewOverlaysAsset).reviews;
  return { ...rows, fingerprint: registrySnapshotFingerprint(rows), transferReviews,
    transferReviewsDigest: computeSafetyScoreV9ReviewedTransferFactsDigest(transferReviews) };
}

/** Load trusted local Git data, never fetch or substitute today's registry. */
export function loadSafetyScoreV9RegistryRef(ref: string): SafetyScoreV9RegistrySnapshot {
  if (!/^[a-f0-9]{7,40}$/u.test(ref)) throw new Error("--registry-ref must be a Git commit SHA (7–40 lowercase hex characters)");
  const root = process.cwd();
  const commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const scratch = resolve(root, "agents/v9-captures/registry-scratch");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(resolve(scratch, "registry-"));
  try {
    const archive = execFileSync("git", ["archive", commit, "shared", "scripts"], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    symlinkSync(resolve(root, "node_modules"), resolve(directory, "node_modules"));
    writeFileSync(resolve(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { paths: { "@shared/*": ["./shared/*"] } },
    }));
    execFileSync(process.execPath, ["--import", "tsx", "scripts/maintenance/generate-stablecoin-per-coin-asset.ts"], {
      cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    const script = `import { ACTIVE_STABLECOINS, FROZEN_STABLECOINS } from './shared/lib/stablecoins/registry';\nimport { DEAD_STABLECOINS } from './shared/lib/dead-stablecoins';\nconsole.log(JSON.stringify({activeStablecoins:ACTIVE_STABLECOINS,frozenStablecoins:FROZEN_STABLECOINS,deadStablecoins:DEAD_STABLECOINS}));`;
    writeFileSync(resolve(directory, "registry.ts"), script);
    const rows = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "registry.ts"], {
      cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    })) as Pick<SafetyScoreV9RegistrySnapshot, "activeStablecoins" | "frozenStablecoins" | "deadStablecoins">;
    const transferReviews = SafetyScoreV9ReviewedTransferFileSchema.parse(JSON.parse(
      readFileSync(resolve(directory, "shared/data/safety-score-v9/transfer-review-overlays-v1.json"), "utf8"),
    )).reviews;
    return { ...rows, fingerprint: registrySnapshotFingerprint(rows), transferReviews,
      transferReviewsDigest: computeSafetyScoreV9ReviewedTransferFactsDigest(transferReviews) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function registryNavAssetIds(snapshot: SafetyScoreV9RegistrySnapshot): ReadonlySet<string> {
  return new Set(snapshot.activeStablecoins.filter((coin) => coin.flags.navToken === true).map((coin) => coin.id));
}
