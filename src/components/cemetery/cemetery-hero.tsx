/**
 * Stablecoin Cemetery hero (server component): the route head (Newsreader h1, one-sentence lead, section links) and
 * the One Beam `113` figure with its sub-line, plaque and at-rest line, handed as children to the client island
 * `PlotMapHero`, which builds the plot map from the same register rows the Autopsy Register receives; then the legend.
 *
 * The server solves the desktop rest pose (`desktopPlotLayout`: header overlap, colossus chips, beam rest per viewport
 * band) because it is too heavy for hydration; only that small layout, the rows and the slim atlas cross to the client.
 */
import type { ReactElement } from "react";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotMapInput, type PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { CEMETERY_HERO_COPY, formatCemeteryPlaque } from "@/lib/cemetery-presentation";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import type { CemeteryStats } from "@/lib/cemetery-stats";
import { digestDisplay } from "@/lib/fonts/digest";
import { formatRegisterDeathDate } from "./cemetery-register-model";
import { PlotMapHero } from "./plot-map-hero";
import { PlotMapLegend } from "./plot-map-legend";
import { desktopPlotLayout } from "./plot-map-scene";
import { PlotMapDefs, plotTokenStyle } from "./plot-map-shapes";
import styles from "./plot-map.module.css";
import mobileStyles from "./plot-map-mobile.module.css";

/** FeatureHeroSplit's `DEFAULT_BEAM_VALUE_CLASS` recipe (brand-accent text: sky-700 on light daylight sky, frost-blue on dark night sky). */
const BEAM_VALUE_CLASS = "pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-brand-accent-text sm:text-[2.45rem]";

export interface CemeteryHeroProps {
  /** Register rows in their default newest-first order (`buildCemeteryRegisterRows`): pass the array the register receives. */
  rows: readonly CemeteryRegisterRow[];
  stats: Pick<CemeteryStats, "total" | "firstYear" | "latestYear" | "heroSubline">;
  /** Latest recorded death (`stats.asOf.date`). */
  asOf: string;
  atlas: PlotLogoAtlas;
  /** `getPortraitAspectRatio(rows, asOf)`: the phone slot's reserved box. */
  portraitAspectRatio: string;
}

export function CemeteryHero({ rows, stats, asOf, atlas, portraitAspectRatio }: CemeteryHeroProps): ReactElement {
  const layout = desktopPlotLayout(buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "desktop" }));
  // Rows arrive newest first, so the first row is the latest recorded death.
  const latest = rows[0];
  return (
    <div className={`${styles.tokens} ${mobileStyles.heroScope}`} style={plotTokenStyle(atlas)}>
      <PlotMapDefs />
      <PlotMapHero rows={rows} asOf={asOf} atlas={atlas} layout={layout} portraitAspectRatio={portraitAspectRatio}>
        <div className={styles.head}>
          <header className={styles.routeHead} data-plot-head>
            <h1 id="cemetery-title" className={`${styles.title} ${digestDisplay.className}`}>
              {CEMETERY_HERO_COPY.title}
            </h1>
            <p className={styles.lead}>Failed or discontinued stablecoins, by cause of death and year.</p>
            <p className={styles.whisper}>
              <span className={styles.onWide}>Click any stone for its obituary · click a cause sign to zoom</span>
              <span className={styles.onPhone}>Tap any stone for its obituary · tap a cause head to highlight</span>
            </p>
            <p className={`${styles.links} ${mobileStyles.heroLinks}`}>
              <a href="#register">Find a coin ↓</a> · <a href="#methodology">Methodology</a> · <a href="#dataset">Dataset</a>
            </p>
          </header>
          <div className={styles.figure} data-plot-figure>
            <p className={styles.beamLabel}>{CEMETERY_HERO_COPY.recordedDeaths}</p>
            <p className={`${styles.figureValue} ${BEAM_VALUE_CLASS}`}>
              <span className={styles.figureDigits} data-plot-figure-value>
                {stats.total}
              </span>
            </p>
            <div>
              <p className={styles.beamSub}>{stats.heroSubline}</p>
              <p className={styles.beamPlaque}>{formatCemeteryPlaque(stats.total, stats.firstYear)}</p>
              {latest ? (
                <p className={styles.beamRest}>
                  {CEMETERY_HERO_COPY.latestDeathPrefix.replace(/\s*·\s*$/, "")}
                  <span className={mobileStyles.beamRestLeadDot}>{" · "}</span>
                  <span className={mobileStyles.beamRestCoin}>
                    <b>{latest.name}</b>
                    {"\u00a0· "}
                    <span className={styles.beamRestDate}>
                      <span className={styles.mono}>{formatRegisterDeathDate(latest.deathDate)}</span>
                    </span>
                  </span>
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </PlotMapHero>
      <PlotMapLegend firstYear={stats.firstYear} lastYear={stats.latestYear} />
      <div className={styles.strataDivider} aria-hidden="true" data-plot-strata-divider>
        <svg className={styles.strataSvg} viewBox="0 0 1200 18" preserveAspectRatio="none" focusable="false">
          <defs>
            <linearGradient id="cem-strata-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className={styles.strataTop} />
              <stop offset="68%" className={styles.strataMid} />
              <stop offset="100%" className={styles.strataBottom} />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="1200" height="18" fill="url(#cem-strata-fill)" />
          <line x1="0" y1="0.5" x2="1200" y2="0.5" className={styles.strataRim} />
          <line x1="0" y1="5" x2="1200" y2="5" className={styles.strataLine} />
          <line x1="0" y1="10" x2="1200" y2="10" className={styles.strataLine} />
          <line x1="0" y1="14.5" x2="1200" y2="14.5" className={styles.strataLine} />
        </svg>
      </div>
    </div>
  );
}
