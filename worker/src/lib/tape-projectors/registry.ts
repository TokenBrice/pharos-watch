import { projectCemeteryEntries } from "./cemetery";
import { projectDepegOpened, projectDepegPeakWorsened, projectDepegResolved } from "./depeg";
import { projectDewsBandTransitions } from "./dews";
import { projectFreezeBlocked, projectFreezeDestroyed, projectFreezeUnblocked } from "./freeze";
import { projectLifecycleFrozen } from "./lifecycle";
import { projectMethodologyBumps } from "./methodology";
import { projectMintBurnLargeFlows } from "./mint-burn";
import { projectPsiBandShifts } from "./psi";
import { projectScoreDowngraded, projectScoreUpgraded } from "./score";
import type { Projector } from "./types";
import { projectYieldPysDropped, projectYieldWarningEmitted } from "./yield";

export interface ProjectTapeJob {
  name: string;
  run: Projector;
}

/** Canonical ordered projector registry shared by scheduled and admin delivery. */
export const TAPE_PROJECTOR_JOBS: readonly ProjectTapeJob[] = [
  { name: "depeg.opened", run: projectDepegOpened },
  { name: "depeg.resolved", run: projectDepegResolved },
  { name: "depeg.peak_worsened", run: projectDepegPeakWorsened },
  { name: "freeze.blocked", run: projectFreezeBlocked },
  { name: "freeze.unblocked", run: projectFreezeUnblocked },
  { name: "freeze.destroyed", run: projectFreezeDestroyed },
  { name: "score.upgraded", run: projectScoreUpgraded },
  { name: "score.downgraded", run: projectScoreDowngraded },
  { name: "psi.band_changed", run: projectPsiBandShifts },
  { name: "dews.band_transitions", run: projectDewsBandTransitions },
  { name: "mint_burn.large_flow", run: projectMintBurnLargeFlows },
  { name: "yield.warning_emitted", run: projectYieldWarningEmitted },
  { name: "yield.pys_dropped", run: projectYieldPysDropped },
  { name: "methodology.bumped", run: projectMethodologyBumps },
  { name: "cemetery.entry.added", run: projectCemeteryEntries },
  { name: "lifecycle.tracked.frozen", run: projectLifecycleFrozen },
];
