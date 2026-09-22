import { z } from "zod";

export const DEPENDENCY_TYPE_VALUES = ["wrapper", "mechanism", "collateral"] as const;

export const DependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);

/** Derived from the one value list so a new dependency type cannot miss the union. */
export type DependencyType = z.infer<typeof DependencyTypeSchema>;

export const V9_DEPENDENCY_ECONOMIC_ROLE_VALUES = [
  "serial-claim",
  "basket-exposure",
  "exit-dependency",
  "control-operator",
  "oracle-nav",
] as const;

export type V9DependencyEconomicRole = (typeof V9_DEPENDENCY_ECONOMIC_ROLE_VALUES)[number];

export const V9DependencyEconomicRoleSchema = z.enum(V9_DEPENDENCY_ECONOMIC_ROLE_VALUES);

export function defaultV9DependencyEconomicRole(dependencyType: DependencyType): V9DependencyEconomicRole {
  return dependencyType === "collateral" ? "basket-exposure" : "serial-claim";
}
