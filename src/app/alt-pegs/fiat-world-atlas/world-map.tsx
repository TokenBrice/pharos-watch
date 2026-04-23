import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORLD_SVG = readFileSync(resolve(process.cwd(), "public/maps/world-countries.svg"), "utf8");

const STYLE_BLOCK = `
.fiat-world-map{--world-default-fill:oklch(0.79 0.015 248 / 1);--world-stroke:oklch(0.48 0.02 248 / 0.58)}
.dark .fiat-world-map{--world-default-fill:oklch(0.22 0.014 248 / 1);--world-stroke:oklch(0.62 0.02 248 / 0.55)}
.fiat-world-map .world-countries{stroke-width:0.7}
`;

export function WorldMap() {
  return (
    <div className="fiat-world-map relative h-full w-full" aria-label="World map backdrop">
      <style>{STYLE_BLOCK}</style>
      <div className="[&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: WORLD_SVG }} />
    </div>
  );
}
