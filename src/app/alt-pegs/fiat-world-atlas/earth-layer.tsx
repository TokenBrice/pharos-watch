import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import type { PegCluster } from "@/lib/alt-peg-hero";

export function EarthLayer({ clusters }: { clusters: readonly PegCluster[] }) {
  return (
    <div className="peg-hero__earth">
      <div className="peg-hero__horizon" aria-hidden="true" />
      <div className="peg-hero__map-frame">
        <WorldMap />
        <FiatEmblems clusters={clusters} />
      </div>
    </div>
  );
}
