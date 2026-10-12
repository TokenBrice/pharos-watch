/**
 * Characterization lock for the Cemetery plot map: SHA-256 of its geometry and rendered markup. The scene kit
 * (`shared/lib/scene/`, `src/components/scene/`) was extracted from this code, and the Cemetery must stay
 * byte-identical through any change to the kit; a changed hash here means a reader of `/cemetery/` sees a different
 * drawing. Re-pin only for an intended visual change, never to absorb a refactor.
 *
 * Class names are normalized to their module-local names (`_st-t_1a2b3c` → `st-t`), so moving a rule between CSS
 * modules does not rotate the markup hashes; a changed class list on an element still does.
 */
import { createHash } from "node:crypto";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
import {
  PLOT_PROJECTIONS,
  desktopSiteMarks,
  graveGeometry,
  graveHitHull,
  plotDrawnObjects,
  portraitSiteMarks,
} from "@/lib/cemetery-plot-geometry";
import { buildCemeteryPlotMap, type DesktopPlotMap, type PortraitPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas, toPlotMapInput, type PlotLogoAtlasManifest } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { PlotMapLegend } from "@/components/cemetery/plot-map-legend";
import { PlotMapPortrait } from "@/components/cemetery/plot-map-portrait";
import { PlotMapScene, desktopPlotLayout } from "@/components/cemetery/plot-map-scene";
import { PlotMapDefs } from "@/components/cemetery/plot-map-shapes";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => sha(JSON.stringify(value));
/** Vitest's stable CSS-module names are `_<local>_<hash>`; keep the local name. */
const markup = (html: string) => sha(html.replace(/\b_([\w-]+?)_[0-9a-f]{5,8}\b/g, "$1"));

const stats = buildCemeteryStats(CEMETERY_ENTRIES);
const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
const input = toPlotMapInput(rows);
const asOf = stats.asOf.date;
const desktop = buildCemeteryPlotMap(input, { asOf, preset: "desktop" }) as DesktopPlotMap;
const portrait = buildCemeteryPlotMap(input, { asOf, preset: "portrait" }) as PortraitPlotMap;
const atlas = toPlotLogoAtlas(atlasManifest as PlotLogoAtlasManifest);

function graves(map: DesktopPlotMap | PortraitPlotMap) {
  const p = PLOT_PROJECTIONS[map.projection];
  return map.graves.map((g) => {
    const geometry = graveGeometry(p, g);
    return { id: g.id, geometry, hit: graveHitHull(p, geometry, g.cell) };
  });
}

const GOLDEN = {
  desktopModel: "935cd23dadbc2f772ef20266533f2d7eaff57eb76e7868303b12269f033b50c9",
  portraitModel: "4805682235bbfbedc83833827ba0ed7459dec8287ffeccaeca77ef1697921234",
  desktopGraves: "2f4a042e62e5ff02a4ea14219bf553418682e697937d557fc76f18fe352410b7",
  portraitGraves: "68bd6a3ef8223afc0e5e70e0855a1b944cc2dcdbbe4f870efb11c45bb83968de",
  drawnObjects: "3475181de8cc5caf73c0745c04f36e45a5bf61b60c23104198d53d69a58632b4",
  desktopSite: "5699710dc16ddd7b8947d77e156dd783f00761f2db23ccdfe7efabbf29e8e76e",
  portraitSite: "b30116f18984560a56a86e316ee3ded5ae1cb96700a3296bebdec8e2f1f15008",
  sceneMarkup: "08bfdcd35d873bfbd2d8941270fd871182602b9dbdc881f8fb52ebb17796d183",
  portraitMarkup: "498e0c5b63b431c0a62edc93d975797202afefb0e866eb6db8cb8110ae98fa84",
  legendMarkup: "c1d79edb85daca70f5036fc2e96b3bd1fd3a8a1db3b1f9aeff16d56782079037",
  defsMarkup: "fc21af83a8edb671f9b0c18982c596a5bbab0f74ddafcc54ed1ceccaa1f5f53c",
};

describe("cemetery scene golden", () => {
  it("keeps the plot-map models byte-stable", () => {
    expect(json(desktop)).toBe(GOLDEN.desktopModel);
    expect(json(portrait)).toBe(GOLDEN.portraitModel);
  });

  it("keeps every grave's geometry and hit hull byte-stable", () => {
    expect(json(graves(desktop))).toBe(GOLDEN.desktopGraves);
    expect(json(graves(portrait))).toBe(GOLDEN.portraitGraves);
  });

  it("keeps the drawn objects and site marks byte-stable", () => {
    expect(json(plotDrawnObjects(desktop))).toBe(GOLDEN.drawnObjects);
    expect(json(desktopSiteMarks(desktop))).toBe(GOLDEN.desktopSite);
    expect(json(portraitSiteMarks(portrait))).toBe(GOLDEN.portraitSite);
  });

  it("keeps the rendered markup byte-stable", () => {
    // The OG card's rest pose (scripts/maintenance/build-og-cemetery.ts).
    const scene = h(PlotMapScene, {
      map: desktop,
      layout: desktopPlotLayout(desktop),
      atlas,
      state: { hotId: null, hotFocus: false, pinnedId: null, tabId: desktop.graves[0]?.id ?? "", dim: null, beamAimed: false, zoom: null, flowers: {} },
    });
    expect(markup(renderToStaticMarkup(scene))).toBe(GOLDEN.sceneMarkup);
    expect(markup(renderToStaticMarkup(h(PlotMapPortrait, { map: portrait, atlas })))).toBe(GOLDEN.portraitMarkup);
    expect(markup(renderToStaticMarkup(h(PlotMapLegend, { firstYear: stats.firstYear, lastYear: stats.latestYear })))).toBe(GOLDEN.legendMarkup);
    expect(markup(renderToStaticMarkup(h(PlotMapDefs)))).toBe(GOLDEN.defsMarkup);
  });
});
