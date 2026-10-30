import { z } from "zod";
import catalog from "@shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json";
import inventory from "@shared/data/safety-score-v9/lane-screening-emitter-inventory-v1.json";
import { V9LaneEmitterDescriptorSchema, type V9LaneEmitterDescriptor } from "@shared/types/safety-score-v9-incidents";
import { LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST } from "./bridge-lane-admin-events";
import { laneIncidentCertificateScreeningSetId } from "./lane-incident-certificate-store";

const sourceSchema = z.object({
  subjectDeploymentKey: z.string(),
  emitters: z.array(z.object({
    address: z.string(), expectedRuntimeCodeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    families: z.array(z.string()).min(1),
  }).strict()).min(1),
  lookbackBlocks: z.number().int().min(50_000),
  provenance: z.object({
    assetIds: z.array(z.string()).min(1), controlIds: z.array(z.string()).min(1),
    rail: z.string(), reviewedAt: z.string(),
    contributors: z.array(z.object({ controlId: z.string(), emitterAddresses: z.array(z.string()).min(1) }).strict()).min(1),
    emitters: z.array(z.object({
      address: z.string(), role: z.enum(["route-deployment", "governed-contract"]),
      label: z.string(), chain: z.string(), observedBlock: z.number().int().nonnegative(), observedAt: z.string(),
      abiBasis: z.object({ kind: z.enum(["verified-source", "same-runtime-code", "same-verified-type"]),
        chain: z.string(), address: z.string(), runtimeIdentity: z.string(), verifiedSourceUrl: z.string().url(),
      }).strict(),
    }).strict()).min(1),
  }).strict(),
}).strict();

/** Pure admission of the producer's reviewed catalog; bad rows never grant closure. */
export function adaptLaneEmitterCatalog(rows: readonly unknown[], policyDigest = LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST): {
  descriptors: V9LaneEmitterDescriptor[]; reasons: string[];
} {
  const descriptors: V9LaneEmitterDescriptor[] = [];
  const reasons: string[] = [];
  for (const [index, raw] of rows.entries()) {
    const parsed = sourceSchema.safeParse(raw);
    if (!parsed.success) { reasons.push(`lane-descriptor-unmappable:${index}`); continue; }
    const row = parsed.data;
    const fail = (reason: string) => reasons.push(`${reason}:${row.subjectDeploymentKey}`);
    if (policyDigest !== LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST) { fail("lane-descriptor-policy-mismatch"); continue; }
    const controls = new Set(row.provenance.controlIds);
    const reviewed = inventory.lanes.find((lane) => lane.subjectDeploymentKey === row.subjectDeploymentKey);
    if (reviewed === undefined || row.emitters.some((emitter) =>
      reviewed.emitters.find((entry) => entry.address === emitter.address)?.runtimeIdentity !==
        `sha256-decoded-runtime-bytes:${emitter.expectedRuntimeCodeSha256}`)) {
      fail("lane-descriptor-pin-mismatch"); continue;
    }
    const addresses = new Set(row.emitters.map((emitter) => emitter.address));
    if (controls.size !== row.provenance.controlIds.length ||
        row.provenance.contributors.length !== controls.size ||
        new Set(row.provenance.contributors.map((entry) => entry.controlId)).size !== controls.size ||
        row.provenance.contributors.some((entry) => !controls.has(entry.controlId) || entry.emitterAddresses.some((address) => !addresses.has(address))) ||
        row.provenance.emitters.length !== addresses.size ||
        new Set(row.provenance.emitters.map((entry) => entry.address)).size !== addresses.size ||
        row.provenance.emitters.some((entry) => !addresses.has(entry.address) || entry.chain !== row.subjectDeploymentKey.split(":")[0])) {
      fail("lane-descriptor-provenance-mismatch"); continue;
    }
    const screeningSetId = laneIncidentCertificateScreeningSetId({
      subjectDeploymentKey: row.subjectDeploymentKey, screeningPolicyDigest: policyDigest,
      contributorControlIds: row.provenance.controlIds, emitters: row.emitters,
    });
    const mapped = row.provenance.assetIds.map((assetId) => V9LaneEmitterDescriptorSchema.safeParse({
      schemaVersion: 1, assetId, subjectDeploymentKey: row.subjectDeploymentKey,
      contributorControlIds: row.provenance.controlIds, screeningPolicyDigest: policyDigest, screeningSetId,
      emitters: row.emitters.map((emitter) => ({ address: emitter.address,
        reviewedRuntimePin: `sha256-decoded-runtime-bytes:${emitter.expectedRuntimeCodeSha256}`, families: emitter.families })),
    }));
    if (mapped.some((entry) => !entry.success)) { fail("lane-descriptor-unmappable"); continue; }
    for (const entry of mapped) if (entry.success) descriptors.push(entry.data);
  }
  return { descriptors, reasons };
}

export function loadReviewedLaneEmitterCatalog() {
  return adaptLaneEmitterCatalog(catalog.descriptors);
}
