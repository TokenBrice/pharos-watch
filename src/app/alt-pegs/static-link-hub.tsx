import type { CSSProperties } from "react";
import Link from "next/link";
import { buildAltPegLinkHubGroups, type AltPegLinkHubItem, type AltPegRegion } from "@/lib/alt-peg-market";

const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();
const FIAT_REGION_ORDER = ["Europe", "Asia", "Americas", "Africa", "Oceania", "Other"] as const;
const ATLAS_REGION_ORDER = ["Americas", "Europe", "Asia", "Africa", "Oceania"] as const;
const ATLAS_VIEWBOX_WIDTH = 780;
const ATLAS_VIEWBOX_HEIGHT = 360;

type FiatMapRegion = Exclude<AltPegRegion, "Other">;

interface AtlasRegionEntry {
  region: FiatMapRegion;
  items: AltPegLinkHubItem[];
  coinCount: number;
  emphasis: number;
}

interface MapPoint {
  x: number;
  y: number;
}

interface MapRect {
  x: number;
  y: number;
  width: number;
}

interface MapRegionLayout {
  accentHex: string;
  anchor: MapPoint;
  badge: MapPoint;
  card: MapRect;
  connectorStart: MapPoint;
  footprintPaths: string[];
}

const ATLAS_LANDMASSES = [
  { key: "greenland", d: "M164 43L185 27L212 23L229 39L223 64L197 72L176 66L164 43Z" },
  {
    key: "north-america",
    d: "M70 104L88 84L118 67L153 57L186 60L212 71L230 88L238 108L230 122L218 131L205 135L191 141L183 151L171 159L149 161L128 156L110 146L96 134L85 122L70 104Z",
  },
  { key: "central-america", d: "M181 148L194 156L203 170L201 182L191 178L182 170L176 158L181 148Z" },
  {
    key: "south-america",
    d: "M198 181L212 191L224 214L229 240L226 269L216 297L203 320L189 314L182 292L184 266L190 240L193 216L189 197L198 181Z",
  },
  { key: "europe", d: "M366 85L382 77L404 77L423 82L438 91L441 103L429 110L410 113L395 109L380 109L370 101L366 85Z" },
  { key: "middle-east", d: "M422 110L439 113L452 121L458 133L451 143L438 143L427 136L422 110Z" },
  {
    key: "africa",
    d: "M430 133L448 126L469 129L487 143L495 165L494 188L485 214L470 241L452 252L438 244L430 223L431 196L425 171L424 149L430 133Z",
  },
  {
    key: "asia",
    d: "M430 86L454 70L494 63L534 66L572 74L608 88L636 104L655 123L661 139L651 150L628 155L605 151L585 157L562 172L539 177L515 173L493 178L470 171L451 156L438 140L430 122L430 86Z",
  },
  { key: "india", d: "M540 162L551 172L552 186L543 195L535 184L536 170L540 162Z" },
  { key: "se-asia", d: "M574 180L585 184L592 194L589 205L579 200L573 188L574 180Z" },
  { key: "japan", d: "M598 148L608 144L614 151L610 160L600 159L598 148Z" },
  { key: "australia", d: "M620 244L651 236L684 240L705 253L704 272L686 286L656 290L629 280L618 260L620 244Z" },
  { key: "new-zealand-north", d: "M713 287L721 294L718 304L710 298L713 287Z" },
  { key: "new-zealand-south", d: "M719 301L726 309L722 318L714 312L719 301Z" },
] as const;

const ATLAS_SOUTH_SHELF_PATH =
  "M24 334L98 328L170 330L248 325L338 327L426 322L524 325L612 320L704 323L756 330L756 342L24 342Z";

function projectLonLat(lon: number, lat: number): MapPoint {
  return {
    x: ((lon + 180) / 360) * ATLAS_VIEWBOX_WIDTH,
    y: ((90 - lat) / 180) * ATLAS_VIEWBOX_HEIGHT,
  };
}

const MAP_REGION_LAYOUT: Record<FiatMapRegion, MapRegionLayout> = {
  Americas: {
    accentHex: "#3b82f6",
    anchor: projectLonLat(-102, 35),
    badge: projectLonLat(-122, 45),
    card: { x: 22, y: 90, width: 175 },
    connectorStart: { x: 197, y: 152 },
    footprintPaths: [
      "M82 84L112 69L149 60L184 64L208 75L222 90L221 111L206 124L184 133L170 149L145 153L122 148L102 137L88 120L82 101L82 84Z",
      "M192 184L204 191L214 209L217 230L214 252L207 276L198 297L190 310L184 296L186 273L191 245L194 220L191 199L192 184Z",
    ],
  },
  Europe: {
    accentHex: "#8b5cf6",
    anchor: projectLonLat(18, 50),
    badge: projectLonLat(0, 60),
    card: { x: 314, y: 16, width: 172 },
    connectorStart: { x: 400, y: 88 },
    footprintPaths: [
      "M378 87L395 81L417 83L431 91L432 103L420 109L399 109L383 103L378 87Z",
    ],
  },
  Asia: {
    accentHex: "#14b8a6",
    anchor: projectLonLat(105, 33),
    badge: projectLonLat(124, 39),
    card: { x: 585, y: 54, width: 176 },
    connectorStart: { x: 585, y: 142 },
    footprintPaths: [
      "M454 80L496 69L543 72L588 83L621 98L639 114L637 131L620 142L594 143L565 152L530 157L499 153L473 142L458 127L454 80Z",
      "M543 163L559 172L566 183L562 194L547 190L538 178L543 163Z",
      "M576 181L588 185L594 195L590 205L579 201L573 189L576 181Z",
    ],
  },
  Africa: {
    accentHex: "#d946ef",
    anchor: projectLonLat(21, 4),
    badge: projectLonLat(6, -8),
    card: { x: 372, y: 250, width: 160 },
    connectorStart: { x: 452, y: 250 },
    footprintPaths: [
      "M446 131L463 127L479 134L489 149L490 171L482 196L468 224L454 236L446 224L445 197L440 171L440 147L446 131Z",
    ],
  },
  Oceania: {
    accentHex: "#6366f1",
    anchor: projectLonLat(139, -28),
    badge: projectLonLat(157, -34),
    card: { x: 618, y: 272, width: 140 },
    connectorStart: { x: 618, y: 304 },
    footprintPaths: [
      "M625 245L653 239L681 245L699 257L697 272L679 282L652 284L629 276L622 262L625 245Z",
    ],
  },
};

function withAlpha(hex: string, alpha: string): string {
  return hex.startsWith("#") && hex.length === 7 ? `${hex}${alpha}` : hex;
}

function formatCoinCount(coinCount: number): string {
  return `${coinCount} coin${coinCount === 1 ? "" : "s"}`;
}

function formatCohortCount(cohortCount: number): string {
  return `${cohortCount} cohort${cohortCount === 1 ? "" : "s"}`;
}

function formatCoverageSummary(coinCount: number, cohortCount: number): string {
  return `${formatCohortCount(cohortCount)} · ${formatCoinCount(coinCount)}`;
}

function getRegionCoinCount(items: AltPegLinkHubItem[]): number {
  return items.reduce((total, item) => total + item.coinCount, 0);
}

function opacityToHex(opacity: number): string {
  return Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function formatOffMapGroupLabel(group: AltPegLinkHubItem["group"]): string {
  switch (group) {
    case "Commodity":
      return "Commodity reference";
    case "Other":
      return "Index-linked / other reference";
    default:
      return group;
  }
}

function pointToStyle(point: MapPoint): CSSProperties {
  return {
    left: `${(point.x / ATLAS_VIEWBOX_WIDTH) * 100}%`,
    top: `${(point.y / ATLAS_VIEWBOX_HEIGHT) * 100}%`,
  };
}

function rectToStyle(rect: MapRect): CSSProperties {
  return {
    left: `${(rect.x / ATLAS_VIEWBOX_WIDTH) * 100}%`,
    top: `${(rect.y / ATLAS_VIEWBOX_HEIGHT) * 100}%`,
    width: `${(rect.width / ATLAS_VIEWBOX_WIDTH) * 100}%`,
  };
}

function buildConnectorPath(start: MapPoint, end: MapPoint): string {
  const dx = end.x - start.x;

  return `M${start.x} ${start.y} C${start.x + dx * 0.4} ${start.y}, ${start.x + dx * 0.78} ${end.y}, ${end.x} ${end.y}`;
}

function LinkChip({
  href,
  label,
  coinCount,
  symbolPreview,
  colorHex,
  className,
  style,
}: {
  href: string;
  label: string;
  coinCount: number;
  symbolPreview: string;
  colorHex: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Link
      href={href}
      aria-label={`${label}, ${formatCoinCount(coinCount)}${symbolPreview ? `. ${symbolPreview}` : ""}`}
      style={style}
      className={[
        "pharos-focus-ring inline-flex min-h-11 flex-col rounded-xl border border-border/65 bg-background/50 px-3 py-2 text-left shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/55 hover:text-foreground",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorHex }} />
        {label}
      </span>
      <span className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatCoinCount(coinCount)}
        {symbolPreview ? ` · ${symbolPreview}` : ""}
      </span>
    </Link>
  );
}

function RegionSummaryPill({
  region,
  cohortCount,
  coinCount,
  accentHex,
}: {
  region: string;
  cohortCount: number;
  coinCount: number;
  accentHex: string;
}) {
  return (
    <div
      className="inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5"
      style={{
        borderColor: withAlpha(accentHex, "24"),
        backgroundColor: withAlpha(accentHex, "0d"),
      }}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: accentHex }} />
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground/92">{region}</span>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatCoverageSummary(coinCount, cohortCount)}
      </span>
    </div>
  );
}

function AtlasBackdrop({
  idSuffix,
  atlasRegions,
}: {
  idSuffix: string;
  atlasRegions: readonly AtlasRegionEntry[];
}) {
  const seaId = `alt-peg-atlas-sea-${idSuffix}`;
  const pacificGlowId = `alt-peg-atlas-pacific-${idSuffix}`;
  const atlanticGlowId = `alt-peg-atlas-atlantic-${idSuffix}`;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${ATLAS_VIEWBOX_WIDTH} ${ATLAS_VIEWBOX_HEIGHT}`}
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={seaId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.205 0.022 248)" />
          <stop offset="56%" stopColor="oklch(0.162 0.018 248)" />
          <stop offset="100%" stopColor="oklch(0.125 0.014 248)" />
        </linearGradient>
        <radialGradient id={pacificGlowId} cx="18%" cy="34%" r="42%">
          <stop offset="0%" stopColor="oklch(0.74 0.07 248 / 0.08)" />
          <stop offset="100%" stopColor="oklch(0.74 0.07 248 / 0)" />
        </radialGradient>
        <radialGradient id={atlanticGlowId} cx="53%" cy="28%" r="36%">
          <stop offset="0%" stopColor="oklch(0.7 0.06 248 / 0.07)" />
          <stop offset="100%" stopColor="oklch(0.7 0.06 248 / 0)" />
        </radialGradient>
      </defs>

      <rect width={ATLAS_VIEWBOX_WIDTH} height={ATLAS_VIEWBOX_HEIGHT} fill={`url(#${seaId})`} />
      <rect width={ATLAS_VIEWBOX_WIDTH} height={ATLAS_VIEWBOX_HEIGHT} fill={`url(#${pacificGlowId})`} />
      <rect width={ATLAS_VIEWBOX_WIDTH} height={ATLAS_VIEWBOX_HEIGHT} fill={`url(#${atlanticGlowId})`} />

      <g fill="none" stroke="oklch(0.61 0.02 248 / 0.12)" strokeWidth="1">
        {[-120, -60, 60, 120].map((longitude) => {
          const x = projectLonLat(longitude, 0).x;
          return <path key={`meridian-${longitude}`} d={`M${x} 18V342`} />;
        })}
        {[-60, -30, 30, 60].map((latitude) => {
          const y = projectLonLat(0, latitude).y;
          return <path key={`parallel-${latitude}`} d={`M18 ${y}H762`} />;
        })}
      </g>

      <g fill="none" stroke="oklch(0.7 0.03 248 / 0.18)" strokeWidth="1.15">
        <path d={`M${projectLonLat(0, 0).x} 16V344`} />
        <path d={`M18 ${projectLonLat(0, 0).y}H762`} />
      </g>

      <path d={ATLAS_SOUTH_SHELF_PATH} fill="oklch(0.32 0.016 248 / 0.38)" />

      <g
        fill="oklch(0.31 0.018 248 / 0.94)"
        stroke="oklch(0.66 0.025 248 / 0.16)"
        strokeLinejoin="round"
        strokeWidth="1.2"
      >
        {ATLAS_LANDMASSES.map((mass) => (
          <path key={`${idSuffix}-${mass.key}`} d={mass.d} />
        ))}
      </g>

      <g strokeLinejoin="round" strokeWidth="1.2">
        {atlasRegions.map(({ region }) => {
          const layout = MAP_REGION_LAYOUT[region];
          return layout.footprintPaths.map((path, index) => (
            <path
              key={`${idSuffix}-${region}-footprint-${index}`}
              d={path}
              fill={withAlpha(layout.accentHex, "16")}
              stroke={withAlpha(layout.accentHex, "30")}
            />
          ));
        })}
      </g>

      <g fill="none" stroke="oklch(0.73 0.03 248 / 0.22)" strokeLinejoin="round" strokeWidth="0.9">
        {ATLAS_LANDMASSES.map((mass) => (
          <path key={`${idSuffix}-${mass.key}-coast`} d={mass.d} />
        ))}
      </g>
    </svg>
  );
}

function AtlasLeadLines({ atlasRegions }: { atlasRegions: readonly AtlasRegionEntry[] }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${ATLAS_VIEWBOX_WIDTH} ${ATLAS_VIEWBOX_HEIGHT}`}
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {atlasRegions.map(({ region }) => {
          const layout = MAP_REGION_LAYOUT[region];
          return (
            <path
              key={`${region}-card-leader`}
              d={buildConnectorPath(layout.connectorStart, layout.badge)}
              stroke={withAlpha(layout.accentHex, "40")}
              strokeWidth="1.45"
            />
          );
        })}
        {atlasRegions.map(({ region }) => {
          const layout = MAP_REGION_LAYOUT[region];
          return (
            <path
              key={`${region}-badge-leader`}
              d={`M${layout.badge.x} ${layout.badge.y}L${layout.anchor.x} ${layout.anchor.y}`}
              stroke={withAlpha(layout.accentHex, "5a")}
              strokeWidth="1.25"
            />
          );
        })}
      </g>
    </svg>
  );
}

function CoverageMarker({ region }: { region: AtlasRegionEntry }) {
  const layout = MAP_REGION_LAYOUT[region.region];
  const haloSize = 30 + region.emphasis * 28;
  const badgeMinWidth = 28 + region.emphasis * 16;

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
        style={pointToStyle(layout.anchor)}
      >
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border"
          style={{
            width: `${haloSize}px`,
            height: `${haloSize}px`,
            borderColor: withAlpha(layout.accentHex, opacityToHex(0.18 + region.emphasis * 0.18)),
            backgroundColor: withAlpha(layout.accentHex, opacityToHex(0.06 + region.emphasis * 0.08)),
          }}
        />
        <div
          className="relative h-3.5 w-3.5 rounded-full border border-background/90 shadow-[0_0_0_3px_oklch(0.11_0.012_248_/_0.84)]"
          style={{ backgroundColor: layout.accentHex }}
        />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background/88 px-2 py-1 backdrop-blur-[2px]"
        data-region={region.region}
        data-coin-count={String(region.coinCount)}
        data-marker-size={String(haloSize)}
        style={{
          ...pointToStyle(layout.badge),
          minWidth: `${badgeMinWidth}px`,
          borderColor: withAlpha(layout.accentHex, "32"),
          boxShadow: "var(--elevation-rest)",
        }}
      >
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold tabular-nums text-foreground/92">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: layout.accentHex }} />
          {region.coinCount}
        </span>
      </div>
    </>
  );
}

function FiatRegionSection({
  region,
  items,
  docked = false,
}: {
  region: AltPegRegion;
  items: AltPegLinkHubItem[];
  docked?: boolean;
}) {
  const slug = region.toLowerCase().replace(/\s+/g, "-");
  const atlasRegion = region !== "Other";
  const layout = atlasRegion ? MAP_REGION_LAYOUT[region] : null;
  const coinCount = getRegionCoinCount(items);

  return (
    <section
      aria-labelledby={`alt-peg-region-${slug}`}
      className={[
        docked && atlasRegion
          ? "absolute z-10 space-y-2.5 rounded-[1.35rem] border bg-card/84 p-3 backdrop-blur-[3px]"
          : "space-y-2",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        docked && atlasRegion && layout
          ? {
              ...rectToStyle(layout.card),
              borderColor: withAlpha(layout.accentHex, "20"),
              boxShadow: "var(--elevation-rest)",
            }
          : undefined
      }
    >
      {docked && atlasRegion && layout ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-4 top-0 h-px"
          style={{
            background: `linear-gradient(90deg, ${withAlpha(layout.accentHex, "00")} 0%, ${withAlpha(layout.accentHex, "88")} 50%, ${withAlpha(layout.accentHex, "00")} 100%)`,
          }}
        />
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: atlasRegion && layout ? layout.accentHex : items[0]?.colorHex }}
          />
          <h4
            id={`alt-peg-region-${slug}`}
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90"
          >
            {region}
          </h4>
        </div>
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatCoverageSummary(coinCount, items.length)}
        </p>
      </div>

      <div className={docked && atlasRegion ? "grid gap-1.5" : "grid gap-2 sm:grid-cols-2 lg:grid-cols-1 lg:gap-1.5"}>
        {items.map((item) => (
          <LinkChip
            key={item.href}
            href={item.href}
            label={item.label}
            coinCount={item.coinCount}
            symbolPreview={item.symbolPreview}
            colorHex={item.colorHex}
            className={docked && atlasRegion ? "min-h-0 px-2.5 py-1.5" : undefined}
            style={
              atlasRegion
                ? {
                    borderColor: withAlpha(item.colorHex, docked ? "1f" : "26"),
                    backgroundColor: withAlpha(item.colorHex, docked ? "0b" : "0d"),
                    boxShadow: docked ? `inset 0 1px 0 ${withAlpha(item.colorHex, "12")}` : undefined,
                  }
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}

function NonGeographicReferenceCard({ item, featured = false }: { item: AltPegLinkHubItem; featured?: boolean }) {
  return (
    <Link
      href={item.href}
      aria-label={`${item.label}, ${formatCoinCount(item.coinCount)}${item.symbolPreview ? `. ${item.symbolPreview}` : ""}`}
      className="pharos-focus-ring block rounded-[1.4rem] border px-4 py-4 text-left transition-[background-color,border-color,box-shadow] hover:bg-background/85"
      style={{
        borderColor: withAlpha(item.colorHex, featured ? "30" : "22"),
        backgroundColor: withAlpha(item.colorHex, featured ? "12" : "0c"),
        boxShadow: featured ? "var(--elevation-rest)" : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p aria-hidden="true" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {formatOffMapGroupLabel(item.group)}
          </p>
          <div className="inline-flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.colorHex }} />
            <span
              className={
                featured
                  ? "text-lg font-semibold tracking-tight text-foreground"
                  : "text-sm font-medium text-foreground"
              }
            >
              {item.label}
            </span>
          </div>
        </div>
        <span
          aria-hidden="true"
          className="rounded-full border border-border/60 bg-background/55 px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground"
        >
          {item.coinCount}
        </span>
      </div>

      <p className={featured ? "mt-3 font-mono text-[11px] tabular-nums text-muted-foreground" : "mt-2 font-mono text-[11px] tabular-nums text-muted-foreground"}>
        {formatCoinCount(item.coinCount)}
        {item.symbolPreview ? ` · ${item.symbolPreview}` : ""}
      </p>
    </Link>
  );
}

export function StaticAltPegLinkHub() {
  const fiatGroup = LINK_HUB_GROUPS.find((group) => group.label === "Fiat") ?? null;
  const sideGroups = LINK_HUB_GROUPS.filter((group) => group.label !== "Fiat");
  const fiatRegions = FIAT_REGION_ORDER.map((region) => ({
    region,
    items: fiatGroup?.items.filter((item) => item.region === region) ?? [],
  })).filter((region) => region.items.length > 0);
  const mapRegions = fiatRegions.filter(
    (region): region is { region: FiatMapRegion; items: AltPegLinkHubItem[] } => region.region !== "Other",
  );
  const otherFiatRegions = fiatRegions.filter(
    (region): region is { region: "Other"; items: AltPegLinkHubItem[] } => region.region === "Other",
  );
  const nonGeographicItems = sideGroups.flatMap((group) => group.items);
  const leadReference = [...nonGeographicItems].sort((left, right) => right.coinCount - left.coinCount)[0] ?? null;
  const secondaryReferences = nonGeographicItems.filter((item) => item.href !== leadReference?.href);
  const maxAtlasCoinCount = Math.max(1, ...mapRegions.map((region) => getRegionCoinCount(region.items)));
  const atlasRegions: AtlasRegionEntry[] = ATLAS_REGION_ORDER.map((region) =>
    mapRegions.find((entry) => entry.region === region),
  )
    .filter((region): region is { region: FiatMapRegion; items: AltPegLinkHubItem[] } => region != null)
    .map((region) => {
      const coinCount = getRegionCoinCount(region.items);

      return {
        ...region,
        coinCount,
        emphasis: Math.sqrt(coinCount / maxAtlasCoinCount),
      };
    });

  return (
    <section aria-labelledby="alt-peg-link-hub" className="space-y-3">
      <div className="space-y-1">
        <p className="pharos-kicker">Drill Down</p>
        <h2 id="alt-peg-link-hub" className="pharos-section-title">
          Explore Peg Cohorts
        </h2>
        <p className="pharos-meta">
          Static route links keep the non-USD cohort taxonomy crawlable and make it easy to jump from the market lens
          into the peg you want to inspect next.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,0.85fr)]">
        {fiatGroup ? (
          <section aria-labelledby="alt-peg-fiat-geography" className="pharos-card-shell overflow-hidden">
            <div className="space-y-3 border-b border-border/60 px-4 py-4 sm:px-5 sm:py-5">
              <div className="space-y-1">
                <h3 id="alt-peg-fiat-geography" className="pharos-kicker">
                  Fiat Reference Regions
                </h3>
                <p className="text-sm text-muted-foreground">
                  The atlas only encodes fiat reference-currency regions. Coverage markers scale with tracked fiat coin
                  count so broader region coverage reads heavier on the map. Commodity, CPI-linked, and other
                  reference cohorts stay off-map so the geography view remains truthful and fast to scan.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {atlasRegions.map(({ region, items, coinCount }) => (
                  <RegionSummaryPill
                    key={region}
                    region={region}
                    cohortCount={items.length}
                    coinCount={coinCount}
                    accentHex={MAP_REGION_LAYOUT[region].accentHex}
                  />
                ))}
              </div>
            </div>

            <div data-alt-peg-layout="desktop-atlas" className="hidden px-4 py-4 sm:px-5 sm:py-5 xl:block">
              <div className="relative aspect-[13/6] overflow-hidden rounded-[1.5rem] border border-border/60 bg-background/35">
                <AtlasBackdrop idSuffix="atlas-desktop" atlasRegions={atlasRegions} />
                <AtlasLeadLines atlasRegions={atlasRegions} />

                <div className="absolute inset-x-0 top-0 h-20 bg-[radial-gradient(circle_at_50%_-12%,oklch(0.72_0.08_248_/_0.08),transparent_70%)]" />
                <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background/65 via-background/12 to-transparent" />

                <div className="absolute left-4 top-4 rounded-xl border border-border/60 bg-background/82 px-3 py-2 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/90">
                    Reference-Currency Regions
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Not issuer, reserve, or circulation geography.
                  </p>
                </div>

                <div className="absolute bottom-4 left-4 rounded-full border border-border/60 bg-background/78 px-3 py-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                  Marker size = tracked fiat coin count
                </div>

                {atlasRegions.map((region) => (
                  <CoverageMarker key={region.region} region={region} />
                ))}

                {atlasRegions.map(({ region, items }) => (
                  <FiatRegionSection key={region} region={region} items={items} docked />
                ))}
              </div>

              {otherFiatRegions.length > 0 ? (
                <div className="border-t border-border/60 pt-4">
                  <div className="rounded-[1.35rem] border border-border/60 bg-muted/12 px-3 py-3">
                    <div className="space-y-3">
                      {otherFiatRegions.map((region) => (
                        <FiatRegionSection key={region.region} region={region.region} items={region.items} />
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div data-alt-peg-layout="region-list" className="space-y-4 px-4 py-4 sm:px-5 sm:py-5 xl:hidden">
              {fiatRegions.map((region) => (
                <FiatRegionSection key={region.region} region={region.region} items={region.items} />
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="alt-peg-nongeographic" className="pharos-card-shell space-y-4 p-4 sm:p-5">
          <div className="space-y-1">
            <h3 id="alt-peg-nongeographic" className="pharos-kicker">
              Non-geographic references
            </h3>
            <p className="text-sm text-muted-foreground">
              Tracked off-map because these cohorts reference assets or indices, not monetary regions. The largest
              off-map cohort stays visually weighted here without taking over the atlas.
            </p>
          </div>

          {leadReference ? <NonGeographicReferenceCard item={leadReference} featured /> : null}

          {secondaryReferences.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              {secondaryReferences.map((item) => (
                <NonGeographicReferenceCard key={item.href} item={item} />
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}
