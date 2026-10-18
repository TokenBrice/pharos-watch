import type { NodeLimitOption } from "@/lib/contagion-layout";

// Keep URL/default-view policy independent of the optional d3-force solver.
// 200 stays inside MAX_COLLISION_PASS_NODES, the largest bounded selection.
export const DEFAULT_NODE_LIMIT: NodeLimitOption = 200;
