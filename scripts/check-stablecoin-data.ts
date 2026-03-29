import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  StablecoinMetaAssetArraySchema,
  CanonicalOrderAssetSchema,
} from "../shared/lib/stablecoins/schema";

const DATA_DIR = "shared/data/stablecoins";

interface DataFile {
  file: string;
  schema: z.ZodType;
  label: string;
}

const DATA_FILES: DataFile[] = [
  { file: "usd-major.json", schema: StablecoinMetaAssetArraySchema, label: "USD major" },
  { file: "usd-minor.json", schema: StablecoinMetaAssetArraySchema, label: "USD minor" },
  { file: "non-usd.json", schema: StablecoinMetaAssetArraySchema, label: "non-USD" },
  { file: "commodity.json", schema: StablecoinMetaAssetArraySchema, label: "commodity" },
  { file: "canonical-order.json", schema: CanonicalOrderAssetSchema, label: "canonical order" },
];

let errorCount = 0;

for (const { file, schema, label } of DATA_FILES) {
  const path = join(DATA_DIR, file);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      const result = schema.safeParse(parsed);
      if (result.success) {
        process.stdout.write(`${path}: ${parsed.length} entries OK\n`);
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

if (errorCount > 0) {
  process.stderr.write(`\n${errorCount} error(s) found in stablecoin data files.\n`);
  process.exit(1);
}
process.stdout.write("Stablecoin data validation: OK\n");
