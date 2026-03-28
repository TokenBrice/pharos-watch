import { z } from "zod";

export type DependencyType = "wrapper" | "mechanism" | "collateral";

export const DEPENDENCY_TYPE_VALUES = ["wrapper", "mechanism", "collateral"] as const;

export const DependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);
