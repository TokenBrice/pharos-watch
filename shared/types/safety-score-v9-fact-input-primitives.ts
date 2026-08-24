import { z } from "zod";
import {
  BaseInputGenerationIdSchema,
  CanonicalTextSchema,
  FractionSchema,
  Sha256Schema,
  UnixSecondsSchema,
} from "./safety-schema-primitives";
import { canonicalArrayBy, V9FailureDomainRefSchema } from "./safety-score-v9-fact-primitives";

export {
  BaseInputGenerationIdSchema,
  CanonicalTextSchema,
  FractionSchema,
  Sha256Schema,
  UnixSecondsSchema,
};

export const PositiveFractionSchema = z.number().finite().positive().max(1);
export const NonNegativeUsdSchema = z.number().finite().nonnegative();
export const CanonicalChainIdSchema = CanonicalTextSchema.refine(
  (value) => /^[a-z0-9][a-z0-9._:-]*$/.test(value),
  "Chain ID must be a canonical lowercase identifier",
);
export const CanonicalStringArraySchema = canonicalArrayBy(CanonicalTextSchema, (value) => value);
export const CanonicalFailureDomainsSchema = canonicalArrayBy(
  V9FailureDomainRefSchema,
  (domain) => `${domain.kind}:${domain.key}`,
);

export const V9ControlCapabilitySchema = z.enum([
  "mint",
  "burn",
  "upgrade",
  "freeze",
  "seize",
  "oracle-update",
  "bridge-mint",
  "custody-transfer",
  "parameter-change",
]);
export const V9ControlKindSchema = z.enum(["mint", "upgrade", "custody", "oracle", "bridge", "freeze", "governance"]);
export const V9ControlScopeSchema = z.enum(["global", "deployment", "exposure", "route"]);
export const V9ControlCapKindSchema = z.enum([
  "bounded",
  "collateral-gated",
  "raiseable",
  "unbounded",
  "not-applicable",
  "unknown",
]);
export const V9ControlCapUnitSchema = z.enum(["token-units", "usd-notional", "supply-fraction"]);
export const V9ClaimImpairmentSchema = z.enum(["none", "bounded", "unbounded", "unknown"]);
export const V9EconomicLossScopeSchema = z.enum(["access-only", "deployment", "reserve-claim", "global-claim", "unknown"]);

export const V9RouteLaneSchema = z.enum(["dex", "redemption"]);
export const V9RouteHolderAccessSchema = z.enum([
  "permissionless",
  "retail-open",
  "institutional-eligible",
  "allowlisted",
  "issuer-only",
  "unknown",
]);
export const V9RouteExecutionModelSchema = z.enum([
  "atomic",
  "deterministic",
  "queued",
  "discretionary",
  "eventual",
  "market-depth",
  "unknown",
]);
export const V9RouteExecutionCertaintySchema = z.enum(["guaranteed", "bounded", "conditional", "discretionary", "unknown"]);
export const V9RouteCoverageClassSchema = z.enum(["exact-complete", "exact-lower-bound", "diagnostic"]);
export const V9RouteSettlementModelSchema = z.enum(["atomic", "same-day", "bounded-delay", "queued", "eventual", "unknown"]);
export const V9RouteOutputKindSchema = z.enum(["tracked-stablecoin", "fiat", "collateral", "basket"]);
export const V9RouteValuationBasisSchema = z.enum(["price", "nav", "fx", "reviewed-par"]);
export const V9RouteValuationConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);

export const V9MechanismQualitySchema = z.enum(["strong", "adequate", "limited", "weak", "failed"]);
export const V9MechanismExitFactKeySchema = z.enum(["physical-redemption", "protocol-redemption"]);
export const V9MechanismExitDispositionSchema = z.enum([
  "supported",
  "issuer-undisclosed",
  "integration-missing",
  "method-unsupported",
  "published-evidence-expired",
]);
