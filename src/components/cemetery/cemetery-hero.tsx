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
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import type { CemeteryStats } from "@/lib/cemetery-stats";
import { digestDisplay } from "@/lib/fonts/digest";
import { formatRegisterDeathDate } from "./cemetery-register-model";
import { PlotMapHero } from "./plot-map-hero";
import { PlotMapLegend } from "./plot-map-legend";
import { desktopPlotLayout } from "./plot-map-scene";
import { PlotMapDefs, plotTokenStyle } from "./plot-map-shapes";
import styles from "./plot-map.module.css";

/** FeatureHeroSplit's `DEFAULT_BEAM_VALUE_CLASS` recipe (frost blue: the page's only frost text). */
const BEAM_VALUE_CLASS = "pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]";

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
    <div className={styles.tokens} style={plotTokenStyle(atlas)}>
      <PlotMapDefs />
      <PlotMapHero rows={rows} asOf={asOf} atlas={atlas} layout={layout} portraitAspectRatio={portraitAspectRatio}>
        <div className={styles.head}>
          <header className={styles.routeHead} data-plot-head>
            <h1 id="cemetery-title" className={`${styles.title} ${digestDisplay.className}`}>
              Stablecoin Cemetery
            </h1>
            <p className={styles.lead}>Failed or discontinued stablecoins, by cause of death and year.</p>
            <p className={styles.links}>
              <a href="#methodology">Methodology</a> · <a href="#register">Register ↓</a> · <a href="#dataset">Dataset</a>
            </p>
          </header>
          <div className={styles.figure} data-plot-figure>
            <p className={styles.beamLabel}>Recorded deaths</p>
            <p className={`${styles.figureValue} ${BEAM_VALUE_CLASS}`} data-plot-figure-value>
              {stats.total}
            </p>
            <div>
              <p className={styles.beamSub}>{stats.heroSubline}</p>
              <p className={styles.beamPlaque}>{`${stats.total} interred · first recorded death ${stats.firstYear}`}</p>
              {latest ? (
                <p className={styles.beamRest}>
                  Latest recorded death · <b>{latest.name}</b> ·{" "}
                  <span className={styles.mono}>{formatRegisterDeathDate(latest.deathDate)}</span>
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </PlotMapHero>
      <PlotMapLegend firstYear={stats.firstYear} lastYear={stats.latestYear} />
    </div>
  );
}
