import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry, GeoJsonProperties } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import { M49_TO_ISO2 } from "./data/m49-to-iso2";

const SRC = resolve("scripts/data/world-countries-110m.json");
const OUT = resolve("public/maps/world-countries.svg");
const WIDTH = 900;
const HEIGHT = 460;

const topology = JSON.parse(readFileSync(SRC, "utf8")) as Topology;
const countries = feature(
  topology,
  topology.objects.countries as GeometryCollection,
) as FeatureCollection<Geometry, GeoJsonProperties>;

const projection = geoNaturalEarth1()
  .fitExtent([[4, 4], [WIDTH - 4, HEIGHT - 24]], countries);
const path = geoPath(projection);

const paths: string[] = [];
for (const feat of countries.features) {
  const id = typeof feat.id === "string" ? feat.id : String(feat.id);
  const iso2 = M49_TO_ISO2[id];
  if (!iso2) continue;
  const d = path(feat);
  if (!d) continue;
  paths.push(`<path id="${iso2}" d="${d}" />`);
}

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="World map">`,
  `<g class="world-countries" fill="var(--world-default-fill)" stroke="var(--world-stroke)" stroke-width="0.5" stroke-linejoin="round">`,
  paths.join(""),
  `</g>`,
  `</svg>`,
].join("\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`Wrote ${paths.length} countries to ${OUT}`);
