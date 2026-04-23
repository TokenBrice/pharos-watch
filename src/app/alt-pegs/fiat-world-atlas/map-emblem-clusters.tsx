import Image from "next/image";
import type { PegEmblemCluster } from "@/lib/alt-peg-emblems";

interface MapEmblemClustersProps {
  clusters: readonly PegEmblemCluster[];
  maxVisible?: number;
}

/**
 * Overlays absolutely-positioned per-peg emblem clusters on top of the world
 * map. The wrapper is pointer-events:none so country hover events still reach
 * the SVG paths underneath.
 */
export function MapEmblemClusters({ clusters, maxVisible = 3 }: MapEmblemClustersProps) {
  if (clusters.length === 0) return null;

  return (
    <ul
      aria-hidden="true"
      data-testid="map-emblem-clusters"
      className="pointer-events-none absolute inset-0 m-0 list-none p-0"
    >
      {clusters.map((cluster) => {
        const visible = cluster.emblems.slice(0, maxVisible);
        const overflow = cluster.emblems.length - visible.length;
        return (
          <li
            key={cluster.peg}
            data-peg={cluster.peg}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-white/15 bg-slate-950/78 px-1.5 py-1 shadow-[0_4px_12px_oklch(0_0_0_/0.4)]"
            style={{
              left: `${cluster.anchor.x}%`,
              top: `${cluster.anchor.y}%`,
            }}
          >
            <span className="flex items-center">
              {visible.map((emblem, index) => (
                <span
                  key={emblem.id}
                  className={
                    index === 0
                      ? "inline-flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-full border border-white/20 bg-slate-100"
                      : "-ml-2 inline-flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-full border border-white/20 bg-slate-100"
                  }
                  title={`${emblem.name} (${emblem.symbol})`}
                >
                  <Image
                    src={emblem.logoSrc}
                    alt=""
                    width={18}
                    height={18}
                    unoptimized
                    className="h-full w-full rounded-full object-contain"
                  />
                </span>
              ))}
            </span>
            {overflow > 0 ? (
              <span
                className="inline-flex h-[18px] items-center rounded-full px-1.5 font-mono text-[10px] font-medium text-white"
                style={{ backgroundColor: `${cluster.colorHex}1f` }}
                data-testid={`overflow-${cluster.peg}`}
              >
                +{overflow}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
