"use client";

import type { CSSProperties } from "react";
import { CohortCoinEmblems, summarizeCohort } from "@/app/alt-pegs/fiat-world-atlas/cohort-coin-emblems";
import type { ShelfGroup } from "@/lib/alt-peg-hero";

type SlotStyle = CSSProperties & { "--slot-size": string };

/**
 * Pegs with no home territory (gold, silver, CPI, unmapped currencies) on one
 * shelf above the map: groups and coins in market-cap order, emblems standing
 * on a shared baseline so size reads as market cap on the map's scale.
 */
export function OffMapShelf({ groups }: { groups: readonly ShelfGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="peg-shelf">
      <p className="peg-shelf__title">Off the map</p>
      <ul className="peg-shelf__groups" aria-label="Commodity and index pegs, by market cap">
        {groups.map((group) => (
          <li key={group.peg} className="peg-shelf__group">
            <div className="peg-shelf__coins">
              {group.coins.map((coin) => (
                <span key={coin.id} className="peg-shelf__slot" style={{ "--slot-size": `${coin.sizePx}px` } as SlotStyle}>
                  <CohortCoinEmblems
                    coins={[coin]}
                    cohortRank={group.rank}
                    summary={summarizeCohort(group.coins, group.cohort)}
                    variant="shelf"
                    loading="eager"
                    hoverCardYPlacement="below"
                  />
                </span>
              ))}
            </div>
            <p className="peg-shelf__label">
              <span className="peg-shelf__dot" style={{ backgroundColor: group.colorHex }} aria-hidden="true" />
              {group.label}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
