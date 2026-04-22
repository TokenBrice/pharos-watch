import { syncGeneratedPerCoinAsset } from "./lib/stablecoin-catalog-sources";

const check = process.argv.includes("--check");

try {
  const result = syncGeneratedPerCoinAsset({ check });
  if (check) {
    console.log(
      `[stablecoin-catalog] ${result.generatedFile}: OK (${result.perCoinCount} per-coin source files)`,
    );
  } else {
    const action = result.changed ? "updated" : "already current";
    console.log(
      `[stablecoin-catalog] ${result.generatedFile}: ${action} (${result.perCoinCount} per-coin source files)`,
    );
  }
} catch (error) {
  console.error(
    "[stablecoin-catalog] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}
