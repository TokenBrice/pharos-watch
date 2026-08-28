import type { ReactNode } from "react";

export const scoringChangelogV727Details: Record<string, ReactNode> = {
  "7.27": (
    <>
      <p>FreezeWatch now uses a four-status freeze model and leaves supply-control risk to Mint Authority.</p>
      <ul className="list-disc list-inside space-y-1">
        <li>The retired Dilutable cohort was re-reviewed under freeze-only semantics.</li>
        <li>Most former Dilutable assets now resolve as Upstream; USDN resolves as Possible.</li>
        <li>KRWO, LUAUSD, and vCRED resolve as No; admin mint authority remains descriptive and unscored.</li>
      </ul>
    </>
  ),
};
