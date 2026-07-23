import { z } from "zod";

export type DependencyType = "wrapper" | "mechanism" | "collateral";

export const DEPENDENCY_TYPE_VALUES = ["wrapper", "mechanism", "collateral"] as const;

export const DependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);

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
