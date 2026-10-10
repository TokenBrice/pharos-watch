import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const DepegLedgerCaptureSchema = z.object({
  schemaVersion: z.literal(1),
  captureId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  observationStartedAtISO: z.string().datetime(),
  observedAtISO: z.string().datetime(),
  sourceUrl: z.string().url(),
  methodologyVersionLabel: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  apiTotal: z.number().int().nonnegative().nullable(),
});

export type DepegLedgerCapture = z.infer<typeof DepegLedgerCaptureSchema>;

export const DEPEG_LEDGER_CAPTURE_RELATIVE_PATH = "metadata/capture.json";

export function depegLedgerCaptureId(dataDir: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(dataDir).filter((name) => /^\d{4}\.json$/.test(name)).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(dataDir, name)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function readDepegLedgerCapture(dataDir: string): DepegLedgerCapture {
  const capture = DepegLedgerCaptureSchema.parse(JSON.parse(readFileSync(join(dataDir, DEPEG_LEDGER_CAPTURE_RELATIVE_PATH), "utf8")));
  if (capture.captureId !== depegLedgerCaptureId(dataDir)) {
    throw new Error("Depeg event shards do not match their capture identity; sync the full ledger before generating datasets");
  }
  if (capture.observationStartedAtISO > capture.observedAtISO) {
    throw new Error("Depeg ledger capture observation interval is reversed");
  }
  return capture;
}
