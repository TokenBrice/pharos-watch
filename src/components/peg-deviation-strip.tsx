"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getCirculatingRaw } from "@shared/lib/supply";
import { buildStablecoinUrl } from "@/lib/urls";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import type { ThreatBand } from "@shared/lib/classification";
import type { PegSummaryCoin } from "@shared/types";

/* Peg-deviation strip plot (Council D12, IDEA-6).
   Horizontal strip per peg-currency cohort. Each coin: dot positioned by
   currentDeviationBps on a symmetric ±500 bps axis, sized by supply (sqrt
   scale), colored by THREAT_BAND_HEX. Faint PEG_BAND_BPS reference lines.
   Pure SVG. */

interface PegDeviationStripProps {
  coins: PegSummaryCoin[];
}

/** Severity thresholds mirror those in `peg-deviation-chart.tsx`. */
const PEG_BAND_BPS = { tight: 25, drift: 50, stress: 100 } as const;

/** Symmetric domain in bps; values past clamp at the edge. */
const DOMAIN_BPS = 500;

const DOT_MIN_R = 2.6;
const DOT_MAX_R = 8;
const ROW_HEIGHT = 56;
const PAD_X = 24;
const SVG_HEIGHT_MIN = 56;

interface CohortDef {
  key: "USD" | "EUR" | "GBP" | "GOLD" | "OTHER";
  label: string;
  membersOf: (peg: string) => boolean;
}

const COHORTS: CohortDef[] = [
  { key: "USD", label: "USD", membersOf: (peg) => peg === "USD" },
  { key: "EUR", label: "EUR", membersOf: (peg) => peg === "EUR" },
  { key: "GBP", label: "GBP", membersOf: (peg) => peg === "GBP" },
  { key: "GOLD", label: "Gold", membersOf: (peg) => peg === "GOLD" || peg === "SILVER" },
  {
    key: "OTHER",
    label: "Other Fiat",
    membersOf: (peg) =>
      peg !== "USD" && peg !== "EUR" && peg !== "GBP" && peg !== "GOLD" && peg !== "SILVER",
  },
];

function classifyBand(absBps: number): ThreatBand {
  if (absBps <= PEG_BAND_BPS.tight) return "CALM";
  if (absBps <= PEG_BAND_BPS.drift) return "WATCH";
  if (absBps <= PEG_BAND_BPS.stress) return "ALERT";
  if (absBps <= 200) return "WARNING";
  return "DANGER";
}

interface DotData {
  id: string;
  symbol: string;
  name: string;
  bps: number;
  clampedBps: number;
  supply: number;
  band: ThreatBand;
}

interface CohortRow {
  key: string;
  label: string;
  dots: DotData[];
}

function buildCohorts(
  coins: Array<PegSummaryCoin & { currentDeviationBps: number }>,
  supplyById: Map<string, number>,
): CohortRow[] {
  return COHORTS.map((cohort) => {
    const dots: DotData[] = coins
      .filter((c) => cohort.membersOf(c.pegCurrency))
      .map((c) => {
        const bps = c.currentDeviationBps;
        const clampedBps = Math.max(-DOMAIN_BPS, Math.min(DOMAIN_BPS, bps));
        return {
          id: c.id,
          symbol: c.symbol,
          name: c.name,
          bps,
          clampedBps,
          supply: Math.max(0, supplyById.get(c.id) ?? 0),
          band: classifyBand(Math.abs(bps)),
        };
      })
      // Render bigger dots later so the small ones don't sit on top.
      .sort((a, b) => a.supply - b.supply);
    return { key: cohort.key, label: cohort.label, dots };
  }).filter((row) => row.dots.length > 0);
}

function sqrtRadiusScale(supply: number, maxSupply: number): number {
  if (maxSupply <= 0 || supply <= 0) return DOT_MIN_R;
  const norm = Math.sqrt(supply) / Math.sqrt(maxSupply);
  return DOT_MIN_R + (DOT_MAX_R - DOT_MIN_R) * norm;
}

function bpsToX(bps: number, plotWidth: number): number {
  return PAD_X + ((bps + DOMAIN_BPS) / (DOMAIN_BPS * 2)) * plotWidth;
}

function formatSignedBps(bps: number): string {
  const rounded = Math.round(bps);
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
}

export function PegDeviationStrip({ coins }: PegDeviationStripProps) {
  const { data: stablecoinList, isLoading: isSupplyLoading } = useStablecoins();
  const [hovered, setHovered] = useState<{
    cohort: string;
    dot: DotData;
    x: number;
    y: number;
  } | null>(null);

  const supplyById = useMemo(() => {
    const map = new Map<string, number>();
    for (const asset of stablecoinList?.peggedAssets ?? []) {
      map.set(asset.id, getCirculatingRaw(asset));
    }
    return map;
  }, [stablecoinList]);

  const cohortRows = useMemo(() => {
    const filtered = coins.filter(
      (c): c is PegSummaryCoin & { currentDeviationBps: number } => c.currentDeviationBps !== null,
    );
    return buildCohorts(filtered, supplyById);
  }, [coins, supplyById]);

  const maxSupply = useMemo(() => {
    let m = 0;
    for (const row of cohortRows) {
      for (const d of row.dots) {
        if (d.supply > m) m = d.supply;
      }
    }
    return m;
  }, [cohortRows]);

  const totalCoins = useMemo(
    () => cohortRows.reduce((acc, row) => acc + row.dots.length, 0),
    [cohortRows],
  );

  if (isSupplyLoading && cohortRows.length === 0) {
    return (
      <Card className="rounded-xl animate-in fade-in duration-300">
        <CardHeader className="pb-3">
          <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Live Peg Deviation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[280px] rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (cohortRows.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Live Peg Deviation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No coins match. Drop a filter or two.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Live Peg Deviation
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Dot position = current deviation (bps). Size = supply. Color = severity band.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {cohortRows.map((row) => (
            <CohortStrip
              key={row.key}
              cohortKey={row.key}
              label={row.label}
              dots={row.dots}
              maxSupply={maxSupply}
              onHoverDot={(dot, x, y) => setHovered({ cohort: row.key, dot, x, y })}
              onLeaveDot={() => setHovered(null)}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>{totalCoins} coins</span>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: THREAT_BAND_HEX.CALM }} />
              &le;25
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: THREAT_BAND_HEX.WATCH }} />
              25-50
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: THREAT_BAND_HEX.ALERT }} />
              50-100
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: THREAT_BAND_HEX.WARNING }} />
              100-200
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: THREAT_BAND_HEX.DANGER }} />
              &gt;200 bps
            </span>
          </div>
        </div>
        {hovered && (
          <p className="sr-only" aria-live="polite">
            {hovered.dot.name} {formatSignedBps(hovered.dot.bps)} bps
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface CohortStripProps {
  cohortKey: string;
  label: string;
  dots: DotData[];
  maxSupply: number;
  onHoverDot: (dot: DotData, x: number, y: number) => void;
  onLeaveDot: () => void;
}

const SVG_VIEW_WIDTH = 800;

function CohortStrip({ cohortKey, label, dots, maxSupply, onHoverDot, onLeaveDot }: CohortStripProps) {
  const plotWidth = SVG_VIEW_WIDTH - PAD_X * 2;
  const midY = ROW_HEIGHT / 2;
  const [active, setActive] = useState<DotData | null>(null);

  // Reference lines for PEG_BAND_BPS thresholds (±25, ±50, ±100 bps), drawn faint.
  const refBpsLines = [
    -PEG_BAND_BPS.stress,
    -PEG_BAND_BPS.drift,
    -PEG_BAND_BPS.tight,
    PEG_BAND_BPS.tight,
    PEG_BAND_BPS.drift,
    PEG_BAND_BPS.stress,
  ];

  // x-axis labels shown only on USD strip (top); other strips share the same axis.
  const showAxisLabels = cohortKey === "USD";

  return (
    <div className="flex items-center gap-3">
      <div className="w-16 shrink-0 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        <div className="font-mono text-[10px] text-muted-foreground/70">{dots.length}</div>
      </div>
      <div className="relative flex-1">
        <svg
          viewBox={`0 0 ${SVG_VIEW_WIDTH} ${Math.max(SVG_HEIGHT_MIN, ROW_HEIGHT)}`}
          preserveAspectRatio="none"
          width="100%"
          height={ROW_HEIGHT}
          role="img"
          aria-label={`${label} cohort, ${dots.length} coins, deviations ranging from ${formatSignedBps(Math.min(...dots.map((d) => d.bps)))} to ${formatSignedBps(Math.max(...dots.map((d) => d.bps)))} bps`}
          className="block overflow-visible"
          onMouseLeave={() => {
            setActive(null);
            onLeaveDot();
          }}
        >
          {/* Severity-band shading */}
          <rect
            x={bpsToX(-PEG_BAND_BPS.tight, plotWidth)}
            width={bpsToX(PEG_BAND_BPS.tight, plotWidth) - bpsToX(-PEG_BAND_BPS.tight, plotWidth)}
            y={midY - 18}
            height={36}
            fill="currentColor"
            className="text-muted-foreground/5"
          />

          {/* Reference lines */}
          {refBpsLines.map((bps) => (
            <line
              key={bps}
              x1={bpsToX(bps, plotWidth)}
              x2={bpsToX(bps, plotWidth)}
              y1={midY - 18}
              y2={midY + 18}
              stroke="currentColor"
              strokeWidth={0.5}
              strokeDasharray="2 3"
              className="text-border/70"
            />
          ))}

          {/* Peg line at 0 bps */}
          <line
            x1={bpsToX(0, plotWidth)}
            x2={bpsToX(0, plotWidth)}
            y1={midY - 22}
            y2={midY + 22}
            stroke="currentColor"
            strokeWidth={1}
            className="text-muted-foreground/60"
          />

          {/* Baseline hairline */}
          <line
            x1={PAD_X}
            x2={PAD_X + plotWidth}
            y1={midY}
            y2={midY}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-border"
          />

          {/* Axis tick labels on top strip only */}
          {showAxisLabels && (
            <g className="font-mono text-[9px] fill-muted-foreground">
              {[-500, -100, 0, 100, 500].map((bps) => (
                <text
                  key={bps}
                  x={bpsToX(bps, plotWidth)}
                  y={10}
                  textAnchor="middle"
                  fill="currentColor"
                >
                  {bps === 0 ? "0" : formatSignedBps(bps)}
                </text>
              ))}
            </g>
          )}

          {/* Dots */}
          {dots.map((dot) => {
            const cx = bpsToX(dot.clampedBps, plotWidth);
            const r = sqrtRadiusScale(dot.supply, maxSupply);
            const isActive = active?.id === dot.id;
            const color = THREAT_BAND_HEX[dot.band];
            return (
              <g key={dot.id}>
                <Link
                  href={buildStablecoinUrl(dot.id)}
                  aria-label={`${dot.name} at ${formatSignedBps(dot.bps)} bps`}
                  onMouseEnter={() => {
                    setActive(dot);
                    onHoverDot(dot, cx, midY);
                  }}
                  onFocus={() => {
                    setActive(dot);
                    onHoverDot(dot, cx, midY);
                  }}
                  onBlur={() => {
                    setActive(null);
                    onLeaveDot();
                  }}
                  onMouseLeave={() => {
                    setActive(null);
                    onLeaveDot();
                  }}
                >
                  <circle
                    cx={cx}
                    cy={midY}
                    r={isActive ? r + 1.5 : r}
                    fill={color}
                    fillOpacity={isActive ? 0.95 : 0.7}
                    stroke={color}
                    strokeWidth={isActive ? 1.5 : 0.5}
                    className="cursor-pointer transition-[fill-opacity,r] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-ring"
                  />
                </Link>
              </g>
            );
          })}
        </svg>

        {active && (
          <div
            className="pointer-events-none absolute z-10 rounded-md border border-border/60 bg-popover px-2 py-1 text-[11px] shadow-lg"
            style={{
              left: `${(bpsToX(active.clampedBps, plotWidth) / SVG_VIEW_WIDTH) * 100}%`,
              top: midY + 14,
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
            }}
          >
            <span className="font-medium">{active.symbol}</span>{" "}
            <span className="pharos-numeric text-muted-foreground">
              {formatSignedBps(active.bps)} bps
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
