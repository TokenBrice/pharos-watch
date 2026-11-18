import { z } from "zod";
import { Sha256Schema, UnixSecondsSchema } from "./safety-schema-primitives";

export const DepegEventProjectionEvidenceSchema = z.object({
  onsetBasis: z.literal("peer-relative").optional(),
  analyticRecoveryAt: UnixSecondsSchema.nullable().optional(),
  peakBasis: z.literal("peer-relative").optional(),
  peakPeerMedianUsd: z.number().finite().positive().optional(),
  peakReview: z.literal("unverified").optional(),
});

export const DEPEG_LEDGER_MANIFEST_KEY = "depeg-events:ledger-manifest:v1";
export const DEPEG_LEDGER_PAGE_SIZE = 1000;

export const DepegLedgerManifestSchema = z.strictObject({
  version: z.literal(1),
  coveredFromSec: UnixSecondsSchema,
  coveredThroughSec: UnixSecondsSchema.positive(),
  total: z.number().int().nonnegative(),
  pages: z.array(z.strictObject({
    cursor: z.string().min(1).max(256).nullable(),
    sha256: Sha256Schema,
  })).min(1).max(1000),
}).refine(({ total, pages, coveredFromSec, coveredThroughSec }) =>
  coveredFromSec < coveredThroughSec
  && pages.length === Math.max(1, Math.ceil(total / DEPEG_LEDGER_PAGE_SIZE))
  && pages[0]?.cursor === null
  && new Set(pages.map(({ cursor }) => cursor)).size === pages.length,
  "Invalid ledger page inventory");

export const DepegLedgerProofSchema = z.strictObject({
  generation: Sha256Schema,
  coveredFromSec: UnixSecondsSchema,
  coveredThroughSec: UnixSecondsSchema.positive(),
}).refine(({ coveredFromSec, coveredThroughSec }) => coveredFromSec < coveredThroughSec, "Empty ledger coverage window");
