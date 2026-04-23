import type { CSSProperties } from "react";
import Link from "next/link";
import {
  buildAltPegLinkHubGroups,
  type AltPegLinkHubItem,
  type AltPegRegion,
} from "@/lib/alt-peg-market";

const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();
const FIAT_REGION_ORDER = ["Europe", "Asia", "Americas", "Africa", "Oceania", "Other"] as const;
const ATLAS_REGION_ORDER = ["Americas", "Europe", "Asia", "Africa", "Oceania"] as const;

type FiatMapRegion = Exclude<AltPegRegion, "Other">;
interface AtlasRegionEntry {
  region: FiatMapRegion;
  items: AltPegLinkHubItem[];
  coinCount: number;
  emphasis: number;
}

const MAP_REGION_LAYOUT: Record<
  FiatMapRegion,
  {
    accentHex: string;
    markerStyle: CSSProperties;
    panelClassName: string;
  }
> = {
  Americas: {
    accentHex: "#3b82f6",
    markerStyle: { top: "31%", left: "18%" },
    panelClassName: "lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:self-start lg:mt-6",
  },
  Europe: {
    accentHex: "#8b5cf6",
    markerStyle: { top: "24%", left: "51%" },
    panelClassName: "lg:col-start-2 lg:row-start-1 lg:self-start lg:mt-3",
  },
  Asia: {
    accentHex: "#14b8a6",
    markerStyle: { top: "31%", left: "71%" },
    panelClassName: "lg:col-start-3 lg:row-start-1 lg:row-span-2 lg:self-start lg:mt-10",
  },
  Africa: {
    accentHex: "#d946ef",
    markerStyle: { top: "55%", left: "58%" },
    panelClassName: "lg:col-start-2 lg:row-start-2 lg:self-end lg:mb-6",
  },
  Oceania: {
    accentHex: "#6366f1",
    markerStyle: { top: "71%", left: "84%" },
    panelClassName: "lg:col-start-3 lg:row-start-3 lg:self-start",
  },
};

const ATLAS_LAND_PATHS = [
  "M183 42L205 30L229 32L239 49L228 64L205 66L189 58L183 42Z",
  "M84 99L109 75L147 60L184 60L208 71L225 87L233 103L231 121L221 133L208 138L198 150L207 158L216 171L213 182L203 177L195 166L180 161L165 167L144 159L123 161L104 152L90 137L79 119L75 103L84 99Z",
  "M202 181L216 191L226 209L229 229L225 251L218 273L209 297L197 320L186 313L182 295L184 270L190 246L193 223L190 205L196 189L202 181Z",
  "M355 92L364 86L370 96L364 104L355 100L355 92Z",
  "M372 90L389 81L416 81L434 90L438 101L427 109L409 111L394 114L380 108L372 98L372 90Z",
  "M416 71L428 62L440 66L438 79L428 88L418 84L416 71Z",
  "M434 87L458 70L497 63L536 65L575 72L612 86L640 104L657 125L659 142L649 154L627 160L604 155L584 160L561 174L537 180L512 176L492 181L472 173L451 158L440 141L434 123L434 87Z",
  "M575 179L585 184L591 195L586 204L575 198L570 186L575 179Z",
  "M598 150L607 146L614 152L608 160L598 159L598 150Z",
  "M429 133L454 126L476 132L490 149L495 170L492 192L483 214L470 242L452 253L439 245L431 223L433 197L427 174L424 151L429 133Z",
  "M484 256L491 262L489 274L481 268L484 256Z",
  "M688 224L702 226L708 234L697 239L686 236L688 224Z",
  "M623 244L651 234L684 237L705 252L704 271L685 286L655 289L630 278L619 258L623 244Z",
  "M716 289L723 295L721 306L713 300L716 289Z",
];

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
      return "Index / other reference";
    default:
      return group;
  }
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
        "pharos-focus-ring inline-flex min-h-11 flex-col rounded-xl border border-border/70 bg-background/55 px-3 py-2 text-left shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/65 hover:text-foreground",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: colorHex }}
        />
        {label}
      </span>
      <span className="mt-1 text-xs text-muted-foreground">
        {formatCoinCount(coinCount)}
        {symbolPreview ? ` · ${symbolPreview}` : ""}
      </span>
    </Link>
  );
}

function RegionSummaryPill({
  region,
  cohortCount,
  accentHex,
}: {
  region: string;
  cohortCount: number;
  accentHex: string;
}) {
  return (
    <div
      className="rounded-full border px-3 py-1.5"
      style={{
        borderColor: withAlpha(accentHex, "2e"),
        backgroundColor: withAlpha(accentHex, "12"),
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: accentHex }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground/90">
          {region}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {cohortCount}
        </span>
      </div>
    </div>
  );
}

function AtlasBackdrop({ idSuffix }: { idSuffix: string }) {
  const gridId = `alt-peg-atlas-grid-${idSuffix}`;
  const seaId = `alt-peg-atlas-sea-${idSuffix}`;

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 780 360"
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="none"
    >
      <defs>
        <pattern id={gridId} width="64" height="64" patternUnits="userSpaceOnUse">
          <path d="M64 0H0V64" fill="none" stroke="oklch(0.62 0.02 250 / 0.16)" strokeWidth="1" />
        </pattern>
        <linearGradient id={seaId} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.19 0.025 250)" />
          <stop offset="55%" stopColor="oklch(0.16 0.02 250)" />
          <stop offset="100%" stopColor="oklch(0.13 0.018 250)" />
        </linearGradient>
      </defs>

      <rect width="780" height="360" fill={`url(#${seaId})`} />
      <rect width="780" height="360" fill={`url(#${gridId})`} opacity="0.55" />

      <g stroke="oklch(0.5 0.02 250 / 0.18)" strokeWidth="1.2">
        <path d="M142 36V324" />
        <path d="M320 30V318" />
        <path d="M520 26V314" />
        <path d="M24 120H756" />
        <path d="M24 198H756" />
        <path d="M24 280H756" />
      </g>

      <g
        fill="oklch(0.31 0.022 248 / 0.95)"
        stroke="oklch(0.58 0.03 248 / 0.18)"
        strokeWidth="1.5"
      >
        <path d="M70 88c24-35 92-47 138-24 28 14 44 41 44 67-14-2-31 2-45 13-18 14-28 32-52 39-28 8-67-5-93-28-23-20-35-54-23-67 11-13 22-17 31-33Z" />
        <path d="M216 186c18 15 31 39 31 63 0 19-8 35-18 50-8 12-12 28-15 46-4 27-16 56-33 73-16-8-26-25-27-46-1-23 15-46 22-67 7-20 5-38 8-58 4-26 13-49 32-61Z" />
        <path d="M372 86c17-14 44-16 63-5 13 8 21 19 23 31-11-3-21 0-29 5-11 7-20 17-32 20-19 5-47-4-56-18-6-10 15-25 31-33Z" />
        <path d="M412 132c21-6 43-3 58 11 17 17 22 42 18 69-4 24-18 42-34 58-15 15-24 34-33 55-16 4-31-7-36-26-6-25 6-45 11-67 5-20 1-39-3-57-4-18-4-37 19-43Z" />
        <path d="M456 82c38-28 110-36 170-19 39 11 74 38 84 71-14-5-28-7-42-4-29 5-51 26-79 32-24 6-50 0-73 7-24 7-46 28-72 25-28-3-56-30-59-57-3-22 27-39 39-55 7-9 18-13 32-20Z" />
        <path d="M649 255c18-7 40-6 55 4 11 7 17 18 17 29-12-2-22 0-31 5-13 8-23 20-37 23-16 4-35-3-48-14-9-9-9-22 0-30 13-11 27-10 44-17Z" />
      </g>
    </svg>
  );
}

function FiatRegionSection({
  region,
  items,
}: {
  region: AltPegRegion;
  items: AltPegLinkHubItem[];
}) {
  const slug = region.toLowerCase().replace(/\s+/g, "-");
  const atlasRegion = region !== "Other";
  const layout = atlasRegion ? MAP_REGION_LAYOUT[region] : null;

  return (
    <section
      aria-labelledby={`alt-peg-region-${slug}`}
      className={[
        "space-y-2",
        atlasRegion
          ? `lg:z-10 lg:rounded-[1.5rem] lg:border lg:border-border/70 lg:bg-background/82 lg:p-3 lg:shadow-[0_20px_45px_oklch(0_0_0_/0.22)] lg:backdrop-blur-[2px] ${layout?.panelClassName ?? ""}`
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        atlasRegion && layout
          ? {
              boxShadow: `0 0 0 1px ${withAlpha(layout.accentHex, "16")}, 0 20px 45px oklch(0 0 0 / 0.22)`,
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: atlasRegion && layout ? layout.accentHex : items[0]?.colorHex }}
          />
          <h4 id={`alt-peg-region-${slug}`} className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90">
            {region}
          </h4>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          {formatCohortCount(items.length)}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 lg:gap-1.5">
        {items.map((item) => (
          <LinkChip
            key={item.href}
            href={item.href}
            label={item.label}
            coinCount={item.coinCount}
            symbolPreview={item.symbolPreview}
            colorHex={item.colorHex}
            className={atlasRegion ? "lg:min-h-0 lg:px-2.5 lg:py-2" : undefined}
            style={
              atlasRegion
                ? {
                    borderColor: withAlpha(item.colorHex, "2b"),
                    backgroundColor: withAlpha(item.colorHex, "0f"),
                    boxShadow: `0 0 0 1px ${withAlpha(item.colorHex, "12")}`,
                  }
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}

function NonGeographicReferenceCard({
  item,
  featured = false,
}: {
  item: AltPegLinkHubItem;
  featured?: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-label={`${item.label}, ${formatCoinCount(item.coinCount)}${item.symbolPreview ? `. ${item.symbolPreview}` : ""}`}
      className="pharos-focus-ring block rounded-[1.4rem] border px-4 py-4 text-left transition-[background-color,border-color,box-shadow] hover:bg-background/85"
      style={{
        borderColor: withAlpha(item.colorHex, featured ? "38" : "28"),
        backgroundColor: withAlpha(item.colorHex, featured ? "14" : "0e"),
        boxShadow: `0 0 0 1px ${withAlpha(item.colorHex, featured ? "18" : "10")}`,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p aria-hidden="true" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {formatOffMapGroupLabel(item.group)}
          </p>
          <div className="inline-flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: item.colorHex }}
            />
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
        <span aria-hidden="true" className="rounded-full border border-border/60 bg-background/55 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {item.coinCount}
        </span>
      </div>

      <p className={featured ? "mt-3 text-sm text-muted-foreground" : "mt-2 text-xs text-muted-foreground"}>
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
  const leadReference =
    [...nonGeographicItems].sort((left, right) => right.coinCount - left.coinCount)[0] ?? null;
  const secondaryReferences = nonGeographicItems.filter((item) => item.href !== leadReference?.href);
  const atlasRegions = ATLAS_REGION_ORDER.map((region) => mapRegions.find((entry) => entry.region === region)).filter(
    (region): region is { region: FiatMapRegion; items: AltPegLinkHubItem[] } => region != null,
  );

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
                <h3 id="alt-peg-fiat-geography" className="pharos-kicker">Fiat Peg Geography</h3>
                <p className="text-sm text-muted-foreground">
                  The atlas only encodes fiat reference regions. Commodity, CPI-linked, and other reference cohorts
                  stay off-map so the geography view remains truthful and fast to scan.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {atlasRegions.map(({ region, items }) => (
                  <RegionSummaryPill
                    key={region}
                    region={region}
                    cohortCount={items.length}
                    accentHex={MAP_REGION_LAYOUT[region].accentHex}
                  />
                ))}
              </div>
            </div>

            <div className="px-4 py-4 sm:px-5 sm:py-5">
              <div className="relative lg:min-h-[31rem]">
                <div className="relative overflow-hidden rounded-[1.5rem] border border-border/60 bg-background/35 px-3 py-3 lg:absolute lg:inset-0 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-0 lg:py-0">
                  <div className="relative h-40 overflow-hidden rounded-[1.25rem] lg:h-full lg:rounded-none">
                    <AtlasBackdrop idSuffix="atlas" />
                    <div className="hidden lg:block absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,oklch(0.75_0.08_248_/_0.08),transparent_72%)]" />
                    <div className="hidden lg:block absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background/70 to-transparent" />
                    <div className="absolute left-3 top-3 rounded-xl border border-border/60 bg-background/82 px-3 py-2 shadow-sm lg:left-4 lg:top-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/90">
                        Reference-Currency Regions
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Not issuer, reserve, or circulation geography.
                      </p>
                    </div>

                    {atlasRegions.map(({ region }) => {
                      const layout = MAP_REGION_LAYOUT[region];
                      return (
                        <div
                          key={region}
                          className="absolute rounded-[1.3rem] border lg:rounded-[2.25rem]"
                          style={{
                            ...layout.overlayStyle,
                            borderColor: withAlpha(layout.accentHex, "26"),
                            background:
                              `radial-gradient(circle at top left, ${withAlpha(layout.accentHex, "2a")} 0%, ${withAlpha(layout.accentHex, "10")} 48%, transparent 100%)`,
                            boxShadow: `inset 0 1px 0 ${withAlpha(layout.accentHex, "20")}`,
                          }}
                        />
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4 grid gap-4 lg:mt-0 lg:min-h-[31rem] lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.82fr)_minmax(0,1.08fr)] lg:grid-rows-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.55fr)] lg:items-start">
                  {atlasRegions.map(({ region, items }) => (
                    <FiatRegionSection key={region} region={region} items={items} />
                  ))}
                  {otherFiatRegions.length > 0 ? (
                    <div className="space-y-4 lg:col-span-3 lg:pt-4">
                      {otherFiatRegions.map((region) => (
                        <FiatRegionSection key={region.region} region={region.region} items={region.items} />
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="alt-peg-nongeographic" className="pharos-card-shell space-y-4 p-4 sm:p-5">
          <div className="space-y-1">
            <h3 id="alt-peg-nongeographic" className="pharos-kicker">Non-geographic references</h3>
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
