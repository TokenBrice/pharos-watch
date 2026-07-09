import {
  createBaseApiQueryRegistry,
  type FrontendApiQueryBaseDescriptor,
  type FrontendStaticApiQueryBaseDescriptor,
} from "@/lib/api-query-contract";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  type MintBurnEventsDescriptorOptions,
  type NonUsdSharePoint,
} from "@/lib/api-query-descriptors";

export type {
  FrontendApiQueryBaseDescriptor,
  FrontendStaticApiQueryBaseDescriptor,
  MintBurnEventsDescriptorOptions,
  NonUsdSharePoint,
};

/** Compatibility projection for policy-only consumers. */
export const FRONTEND_API_QUERY_BASE_REGISTRY = createBaseApiQueryRegistry(
  FRONTEND_API_QUERY_DESCRIPTORS,
);
