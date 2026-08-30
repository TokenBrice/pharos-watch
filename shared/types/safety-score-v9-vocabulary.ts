import { z } from "zod";

export const V9_EVIDENCE_RESPONSIBILITIES = [
  "integration-missing", "issuer-undisclosed", "measured-adverse",
  "method-unsupported", "producer-failed", "published-evidence-expired",
] as const;
export const V9EvidenceResponsibilitySchema = z.enum(V9_EVIDENCE_RESPONSIBILITIES);
export const V9BoundedEvidenceResponsibilitySchema = V9EvidenceResponsibilitySchema.exclude(["measured-adverse"]);

export const V9_ACCESS_POSTURE_FIELDS = ["transfer", "freezeExposure", "primaryExit", "governance"] as const;
export const V9AccessPostureFieldSchema = z.enum(V9_ACCESS_POSTURE_FIELDS);
export const V9_ACCESS_TRANSFER_VALUES = ["permissionless", "restrictable", "permissioned", "unknown"] as const;
export const V9AccessTransferSchema = z.enum(V9_ACCESS_TRANSFER_VALUES);
export const V9_ACCESS_FREEZE_EXPOSURE_VALUES = ["none-known", "upstream", "direct", "possible", "unknown"] as const;
export const V9AccessFreezeExposureSchema = z.enum(V9_ACCESS_FREEZE_EXPOSURE_VALUES);
export const V9_ACCESS_PRIMARY_EXIT_VALUES = [
  "permissionless", "eligibility-gated", "issuer-discretionary", "none", "undisclosed", "unknown",
] as const;
export const V9AccessPrimaryExitSchema = z.enum(V9_ACCESS_PRIMARY_EXIT_VALUES);
export const V9_ACCESS_GOVERNANCE_VALUES = ["immutable", "distributed", "concentrated", "single-entity", "unknown"] as const;
export const V9AccessGovernanceSchema = z.enum(V9_ACCESS_GOVERNANCE_VALUES);
