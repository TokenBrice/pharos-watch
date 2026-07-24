export const RESERVE_EVIDENCE_SOURCE_ORIGIN_CLASSES = [
  "issuer-attested",
  "onchain-observation",
  "independent-assurance",
  "reviewed-curation",
  "unknown",
] as const;

export type ReserveEvidenceSourceOriginClass =
  (typeof RESERVE_EVIDENCE_SOURCE_ORIGIN_CLASSES)[number];
