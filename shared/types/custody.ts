import { z } from "zod";

export const CUSTODY_PROVIDER_ROLE_VALUES = ["custodian", "subcustodian", "bank", "prime-broker", "other"] as const;
export type CustodyProviderRole = (typeof CUSTODY_PROVIDER_ROLE_VALUES)[number];

export const CUSTODY_SEGREGATION_VALUES = ["segregated", "omnibus", "mixed", "unknown"] as const;
export type CustodySegregation = (typeof CUSTODY_SEGREGATION_VALUES)[number];

export const CUSTODY_BANKRUPTCY_REMOTENESS_VALUES = ["structured", "contractual-only", "none", "unknown"] as const;
export type CustodyBankruptcyRemoteness = (typeof CUSTODY_BANKRUPTCY_REMOTENESS_VALUES)[number];

export const CUSTODY_REHYPOTHECATION_VALUES = ["prohibited", "permitted", "conditional", "unknown"] as const;
export type CustodyRehypothecation = (typeof CUSTODY_REHYPOTHECATION_VALUES)[number];

export const CUSTODY_MODEL_VALUES = [
  "onchain",
  "institutional-top",
  "institutional-regulated",
  "institutional-unregulated",
  "institutional-sanctioned",
  "cex",
  "mixed",
  "unknown",
] as const;
export type CustodyModel = (typeof CUSTODY_MODEL_VALUES)[number];
export const CustodyModelSchema = z.enum(CUSTODY_MODEL_VALUES);
