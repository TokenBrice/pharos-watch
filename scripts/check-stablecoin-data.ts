import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  StablecoinMetaAssetArraySchema,
  CanonicalOrderAssetSchema,
} from "../shared/lib/stablecoins/schema";
import { CHAIN_META } from "../shared/lib/chains";
import type { StablecoinMeta } from "../shared/types";

const DATA_DIR = "shared/data/stablecoins";
const STABLECOIN_ASSET_FILES = new Set([
  "usd-major.json",
  "usd-minor.json",
  "non-usd.json",
  "commodity.json",
  "pre-launch.json",
]);

interface DataFile {
  file: string;
  schema: z.ZodType;
}

const DATA_FILES: DataFile[] = [
  { file: "usd-major.json", schema: StablecoinMetaAssetArraySchema },
  { file: "usd-minor.json", schema: StablecoinMetaAssetArraySchema },
  { file: "non-usd.json", schema: StablecoinMetaAssetArraySchema },
  { file: "commodity.json", schema: StablecoinMetaAssetArraySchema },
  { file: "pre-launch.json", schema: StablecoinMetaAssetArraySchema },
  { file: "canonical-order.json", schema: CanonicalOrderAssetSchema },
];

let errorCount = 0;
const stablecoinEntries: Array<{ file: string; coin: StablecoinMeta }> = [];

function hasSupportedOnchainSupplyContract(coin: StablecoinMeta): boolean {
  return coin.contracts?.some((contract) => {
    if (contract.chain === "solana") return true;
    return CHAIN_META[contract.chain]?.type === "evm" && contract.address.startsWith("0x");
  }) ?? false;
}

function getRuntimeAdmissionIssue(coin: StablecoinMeta): string | null {
  if (coin.status === "pre-launch") return null;
  if (coin.llamaId) return null;

  const isCommodity = coin.flags.pegCurrency === "GOLD" || coin.flags.pegCurrency === "SILVER";
  if (isCommodity && coin.geckoId) return null;

  if (coin.detailProvider === "coingecko") {
    if (coin.geckoId || hasSupportedOnchainSupplyContract(coin)) return null;

    return (
      "active detailProvider=coingecko asset needs geckoId or a supported on-chain supply contract " +
      "so sync-stablecoins can admit it into /api/stablecoins"
    );
  }

  if (coin.detailProvider === "defillama") {
    return "active detailProvider=defillama asset needs llamaId for /api/stablecoins cache admission";
  }

  if (coin.detailProvider === "commodity") {
    return "active commodity detailProvider asset needs geckoId for /api/stablecoins cache admission";
  }

  return (
    "active asset lacks a /api/stablecoins cache admission path; add llamaId, or mark detailProvider=coingecko " +
    "with geckoId or a supported on-chain supply contract"
  );
}

function getStatusPartitionIssue(file: string, coin: StablecoinMeta): string | null {
  if (file === "pre-launch.json") {
    return coin.status === "pre-launch"
      ? null
      : "pre-launch.json may only contain assets with status=pre-launch";
  }

  return coin.status === "pre-launch"
    ? "pre-launch assets belong in shared/data/stablecoins/pre-launch.json"
    : null;
}

for (const { file, schema } of DATA_FILES) {
  const path = join(DATA_DIR, file);
  try {
    // Repo-owned validation only reads from the curated stablecoin data directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      const result = schema.safeParse(parsed);
      if (result.success) {
        process.stdout.write(`${path}: ${parsed.length} entries OK\n`);
        if (STABLECOIN_ASSET_FILES.has(file)) {
          stablecoinEntries.push(
            ...(result.data as StablecoinMeta[]).map((coin) => ({ file, coin })),
          );
        }
      } else {
        for (const issue of result.error.issues) {
          const pathStr = issue.path.length > 0 ? `[${issue.path.join(".")}]` : "";
          const entry =
            issue.path.length > 0 && typeof issue.path[0] === "number"
              ? parsed[issue.path[0]]
              : undefined;
          const id =
            typeof entry === "object" && entry !== null && "id" in entry
              ? (entry as { id: string }).id
              : "";
          process.stderr.write(`${path}${pathStr} (${id}): ${issue.message}\n`);
          errorCount++;
        }
      }
    } else {
      process.stderr.write(`${path}: expected array, got ${typeof parsed}\n`);
      errorCount++;
    }
  } catch (err) {
    process.stderr.write(`${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    errorCount++;
  }
}

for (const { file, coin } of stablecoinEntries) {
  const partitionIssue = getStatusPartitionIssue(file, coin);
  if (partitionIssue) {
    process.stderr.write(`${join(DATA_DIR, file)} (${coin.id}): ${partitionIssue}\n`);
    errorCount++;
  }

  const issue = getRuntimeAdmissionIssue(coin);
  if (!issue) continue;
  process.stderr.write(`${join(DATA_DIR, file)} (${coin.id}): ${issue}\n`);
  errorCount++;
}

if (errorCount > 0) {
  process.stderr.write(`\n${errorCount} error(s) found in stablecoin data files.\n`);
  process.exit(1);
}
process.stdout.write("Stablecoin data validation: OK\n");
