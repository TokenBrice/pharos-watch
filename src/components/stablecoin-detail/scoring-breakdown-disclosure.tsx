"use client";

import type { ReactNode } from "react";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";

export function ScoringBreakdownDisclosure({ children }: { children: ReactNode }) {
  return <ModuleDisclosure label="Scoring breakdown">{children}</ModuleDisclosure>;
}
