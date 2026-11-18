import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { DEPEG_LEDGER_MANIFEST_KEY, DEPEG_LEDGER_PAGE_SIZE, DepegLedgerManifestSchema } from "@shared/types/depeg-event-projection";
import { DepegEventsResponseSchema } from "@shared/types/peg";
import { Sha256Schema, UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { CliUsageError, parseStrictCliArgs, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { handleDepegEvents } from "../src/api/depeg-events";
import { sqlString } from "./lib/remote-d1";

const Attestation = z.strictObject({
  version: z.literal(1),
  scope: z.literal("whole-public-depeg-ledger"),
  snapshotSha256: Sha256Schema,
  coveredFromSec: UnixSecondsSchema,
  coveredThroughSec: UnixSecondsSchema.positive(),
  attestedAtSec: UnixSecondsSchema.positive(),
  attestedBy: z.string().trim().min(1),
  coverageEvidenceRef: z.string().trim().min(1),
}).refine((a) => a.coveredFromSec < a.coveredThroughSec && a.coveredThroughSec <= a.attestedAtSec,
  "Coverage must be a nonempty half-open interval ending at or before its attestation");

const digest = (value: unknown) => createHash("sha256").update(stableJsonStringifyV1(value)).digest("hex");

async function buildPages(db: D1Database) {
  const pages: { cursor: string | null; sha256: string }[] = [];
  const cursors = new Set<string | null>();
  const url = new URL("https://snapshot.invalid/api/depeg-events");
  url.searchParams.set("limit", String(DEPEG_LEDGER_PAGE_SIZE));
  let total: number | undefined;
  let seen = 0;
  for (let page = 0; page < 1000; page++) {
    const cursor = url.searchParams.get("cursor");
    if (cursors.has(cursor)) throw new Error("Repeated source ledger cursor");
    cursors.add(cursor);
    const response = await handleDepegEvents(db, url);
    if (!response.ok) throw new Error(`Whole-source ledger read failed (HTTP ${response.status})`);
    const body: unknown = await response.json();
    const parsed = DepegEventsResponseSchema.parse(body);
    const { events, nextCursor } = parsed;
    total ??= parsed.total;
    if (parsed.totalExact !== true || parsed.total !== total || nextCursor === undefined ||
        events.length !== Math.min(DEPEG_LEDGER_PAGE_SIZE, total - seen)) throw new Error("Incomplete source ledger page");
    // Hash the exact public bytes under the API's canonical serializer, including additive fields.
    const wire = body as { events: unknown[] };
    pages.push({ cursor, sha256: digest({ events: wire.events, total, nextCursor }) });
    seen += events.length;
    if (nextCursor === null && seen === total) return { total, pages };
    if (!nextCursor || seen >= total) throw new Error("Invalid source ledger terminal cursor");
    url.searchParams.set("cursor", nextCursor);
  }
  throw new Error("Source ledger exceeds the manifest page budget");
}

/** Prepare one import statement from a reviewed SQLite export. This command never opens the live database. */
export async function prepareDepegLedgerManifest(snapshotPath: string, attestation: unknown) {
  const receipt = Attestation.parse(attestation);
  if (receipt.attestedAtSec > Math.floor(Date.now() / 1000)) throw new Error("Future source attestation");
  const directory = await mkdtemp(join(tmpdir(), "pharos-depeg-ledger-"));
  try {
    // Separate directory excludes WAL and journal sidecars. Verify the private, single-file export before querying it.
    const path = join(directory, "snapshot.sqlite");
    await copyFile(snapshotPath, path, constants.COPYFILE_FICLONE);
    const sha = createHash("sha256");
    for await (const chunk of createReadStream(path)) sha.update(chunk);
    if (sha.digest("hex") !== receipt.snapshotSha256) throw new Error("Source snapshot SHA-256 differs from attestation");
    // The D1 batch adapter takes SQLite write locks for atomic snapshot reads.
    // Only the verified private copy may acquire locks or materialize derived state.
    await chmod(path, 0o600);
    const sqlite = new DatabaseSync(path);
    try {
      const manifest = DepegLedgerManifestSchema.parse({
        version: 1, coveredFromSec: receipt.coveredFromSec, coveredThroughSec: receipt.coveredThroughSec,
        ...await buildPages(createSqliteD1(sqlite)),
      });
      const value = stableJsonStringifyV1(manifest);
      const sql = [
        `-- Whole-ledger source attestation SHA-256 ${digest(receipt)}; SQLite SHA-256 ${receipt.snapshotSha256}`,
        `INSERT INTO cache (key, value, updated_at) VALUES (${sqlString(DEPEG_LEDGER_MANIFEST_KEY)}, ${sqlString(value)}, ${receipt.attestedAtSec})`,
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        "WHERE excluded.updated_at > cache.updated_at;",
      ].join("\n");
      return { manifest, sql };
    } finally { sqlite.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const usage = "node --import tsx worker/scripts/one-shot-backfill.ts prepare-depeg-ledger-manifest --sqlite <standalone-export> --attestation <source-receipt.json> --output-sql <new-file>";
export async function runPrepareDepegLedgerManifest(argv: readonly string[]) {
  const { values } = parseStrictCliArgs(argv, {
    options: { sqlite: { type: "string" }, attestation: { type: "string" }, "output-sql": { type: "string" } },
  });
  if (writeCliHelpIfRequested(values, usage)) return;
  if (typeof values.sqlite !== "string" || typeof values.attestation !== "string" || typeof values["output-sql"] !== "string") {
    throw new CliUsageError("Expected a SQLite export, separate source attestation and new SQL output path");
  }
  if ((await stat(values.attestation)).size > 64 * 1024) throw new Error("Source attestation exceeds 64 KiB");
  const { sql } = await prepareDepegLedgerManifest(values.sqlite, JSON.parse(await readFile(values.attestation, "utf8")));
  await writeFile(values["output-sql"], sql + "\n", { flag: "wx", mode: 0o600 });
}
