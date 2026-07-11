/**
 * Build-time compatibility name. The registry now shares the exact cached lazy
 * schema sources used by browser hooks; build consumers resolve them before
 * validation instead of maintaining a second eager schema table.
 */
export type {
  FrontendApiQueryDescriptor,
  FrontendStaticApiQueryDescriptor,
} from "@/lib/api-query-contract";
export type {
  MintBurnEventsDescriptorOptions,
  NonUsdSharePoint,
} from "@/lib/api-query-descriptors";
export {
  FRONTEND_API_QUERY_DESCRIPTORS as FRONTEND_API_QUERY_REGISTRY,
} from "@/lib/api-query-descriptors";
