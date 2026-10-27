/**
 * Curated "How does X break?" dossier scenarios (`data/failure-scenarios.json`).
 * Each record is a hypothetical, maintainer-reviewed failure path. It never
 * feeds the Safety Score; a record only publishes once the maintainer approves
 * its exact content (see `review`).
 */

import { z } from "zod";
import { CanonicalTextSchema, Sha256Schema, StrictIsoDateSchema } from "./safety-schema-primitives";
import { HttpUrlSchema } from "./validators";

const EvidenceSchema = z.enum(["verified-onchain", "documented", "inferred", "unverified"]);
const TimestampSchema = z.iso.datetime({ offset: true });
const ObservationDateSchema = z.union([StrictIsoDateSchema, TimestampSchema]);
const BlockSchema = z.number().int().nonnegative();
const ChainIdSchema = z.number().int().positive();
const SourceIdsSchema = z.array(CanonicalTextSchema);

export const FailureScenarioStageSchema = z.object({
  id: CanonicalTextSchema,
  kind: z.enum([
    "premise", "authority-capture", "governance", "mint-or-upgrade", "market-shock",
    "counterparty-failure", "redemption-blocked", "holder-outcome",
  ]),
  title: CanonicalTextSchema,
  actor: CanonicalTextSchema,
  action: CanonicalTextSchema,
  actionIsCode: z.boolean().optional(),
  targets: z.array(z.object({
    label: CanonicalTextSchema,
    address: z.templateLiteral(["0x", z.string()]),
    chainId: ChainIdSchema,
  }).strict()).optional(),
  elapsed: CanonicalTextSchema,
  cost: CanonicalTextSchema,
  missingDefense: CanonicalTextSchema.optional(),
  explanation: CanonicalTextSchema,
  evidence: EvidenceSchema,
  sourceIds: SourceIdsSchema,
}).strict();

export const FailureScenarioStructuralSchema = z.object({
  coinId: CanonicalTextSchema,
  title: CanonicalTextSchema,
  thesis: CanonicalTextSchema,
  premise: CanonicalTextSchema,
  stages: z.array(FailureScenarioStageSchema).min(1),
  branchPoint: z.object({
    afterStageId: CanonicalTextSchema,
    branches: z.array(z.object({
      id: CanonicalTextSchema,
      label: CanonicalTextSchema,
      keys: CanonicalTextSchema,
      premise: CanonicalTextSchema,
      stages: z.array(FailureScenarioStageSchema).min(1),
    }).strict()).min(2),
  }).strict().optional(),
  keyFigures: z.array(z.object({
    value: CanonicalTextSchema,
    label: CanonicalTextSchema,
    evidence: EvidenceSchema,
    sourceIds: SourceIdsSchema,
  }).strict()),
  window: z.object({
    label: CanonicalTextSchema,
    fromStageId: CanonicalTextSchema,
    toStageId: CanonicalTextSchema,
    duration: CanonicalTextSchema,
    note: CanonicalTextSchema,
  }).strict().optional(),
  defenders: z.array(z.object({
    name: CanonicalTextSchema,
    verdict: z.enum(["cannot-stop", "partial", "can-stop", "unverified"]),
    why: CanonicalTextSchema,
    evidence: EvidenceSchema,
    sourceIds: SourceIdsSchema,
  }).strict()),
  falsifiers: z.array(z.object({
    id: CanonicalTextSchema,
    condition: CanonicalTextSchema,
    status: z.enum(["not-met", "met", "unverified"]),
    checkedAtBlock: BlockSchema.optional(),
  }).strict()),
  exposure: z.array(z.object({
    label: CanonicalTextSchema,
    detail: CanonicalTextSchema,
    evidence: EvidenceSchema,
  }).strict()),
  sources: z.array(z.object({
    id: CanonicalTextSchema,
    label: CanonicalTextSchema,
    url: HttpUrlSchema.transform((value) => value as `http${string}`),
    observedAt: ObservationDateSchema.optional(),
    block: BlockSchema.optional(),
  }).strict()),
  evidencePin: z.object({
    chainId: ChainIdSchema,
    block: BlockSchema,
    observedAt: ObservationDateSchema,
  }).strict(),
  review: z.discriminatedUnion("status", [
    z.object({ status: z.literal("draft"), note: CanonicalTextSchema.optional() }).strict(),
    z.object({
      status: z.literal("approved"),
      reviewedBy: CanonicalTextSchema,
      reviewedAt: TimestampSchema,
      contentSha256: Sha256Schema,
    }).strict(),
  ]),
}).strict();

export type FailureScenario = z.output<typeof FailureScenarioStructuralSchema>;
export type FailureScenarioStage = FailureScenario["stages"][number];
export type FailureScenarioEvidence = FailureScenarioStage["evidence"];
export type FailureScenarioDefender = FailureScenario["defenders"][number];
export type FailureScenarioDefenderVerdict = FailureScenarioDefender["verdict"];
export type FailureScenarioFalsifier = FailureScenario["falsifiers"][number];
export type FailureScenarioFalsifierStatus = FailureScenarioFalsifier["status"];
export type FailureScenarioSource = FailureScenario["sources"][number];
/** Alternative routes rejoin at the next trunk stage, never run sequentially. */
export type FailureScenarioBranchPoint = NonNullable<FailureScenario["branchPoint"]>;
export type FailureScenarioBranch = FailureScenarioBranchPoint["branches"][number];
export type FailureScenariosById = Record<string, FailureScenario>;
