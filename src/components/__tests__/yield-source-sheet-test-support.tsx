import { render } from "@testing-library/react";
import { vi } from "vitest";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import type { YieldRanking } from "@shared/types";

export function renderYieldSourceSheet(
  ranking: YieldRanking,
  overrides: Partial<React.ComponentProps<typeof YieldSourceSheet>> = {},
) {
  return render(
    <YieldSourceSheet
      ranking={ranking}
      logo={undefined}
      riskFreeRate={0.02}
      medianApy={0.03}
      open
      onOpenChange={vi.fn()}
      {...overrides}
    />,
  );
}
