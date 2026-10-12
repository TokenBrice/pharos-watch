import { SceneMarks } from "@/components/scene/scene-marks";
import { lighthouseGeometry } from "@shared/lib/scene/objects/lighthouse";
import { SCENE_DIMETRIC } from "@shared/lib/scene/projection";
import kit from "@/components/scene/scene-tokens.module.css";

export const BEACON_PROJECTION = SCENE_DIMETRIC;

const TOWER = lighthouseGeometry(BEACON_PROJECTION, 0, 0);

function classOf(cls: string): string {
  return cls
    .split(" ")
    .map((token) => kit[token] ?? token)
    .join(" ");
}

/** The kit lighthouse at the beacon origin: the same object the Cemetery and Harbor draw. */
export function BeaconTower() {
  return (
    <g aria-hidden="true">
      <SceneMarks marks={TOWER.marks} classOf={classOf} />
    </g>
  );
}
