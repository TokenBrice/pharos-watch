/** Public compatibility facade for the P4 exit-route compiler. */
export {
  DEX_ROUTE_SOURCE_CAPABILITIES,
  isDexExitRouteCoverageComplete,
  isDexExitRouteCoverageWithinRouteBudget,
} from "./p4-exit-route-capability-policy";
export type {
  P4DexRouteObservationResult,
} from "./p4-exit-route-capability-policy";
export {
  P4_AMM_MODELED_TVL_MAX_RATIO,
  P4_AMM_MODELED_TVL_MIN_RATIO,
} from "./p4-exit-route-amm-simulation";
export { buildP4DexExitRouteObservations } from "./p4-exit-route-observation-assembly";
export { validateExitRouteCapacityCurve } from "./exit-route-capacity-point";
