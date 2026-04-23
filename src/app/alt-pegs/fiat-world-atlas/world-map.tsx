import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { buildCountryColorMap } from "@/lib/alt-peg-geography";

const WORLD_SVG = readFileSync(
  resolve(process.cwd(), "public/maps/world-countries.svg"),
  "utf8",
);

function buildStyleBlock(fills: ReadonlyMap<string, { colorHex: string }>): string {
  const rules: string[] = [
    `.fiat-world-map{--world-default-fill:oklch(0.28 0.014 248 / 1);--world-stroke:oklch(0.62 0.02 248 / 0.85)}`,
    `.fiat-world-map .world-countries{stroke-width:0.7}`,
    `.fiat-world-map .world-countries path{transition:fill 180ms ease,filter 180ms ease}`,
    `.fiat-world-map path[data-tracked="true"]:hover{filter:brightness(1.25) saturate(1.1)}`,
  ];
  for (const [iso, fill] of fills) {
    rules.push(`.fiat-world-map path#${iso}{fill:${fill.colorHex};stroke:${fill.colorHex}}`);
  }
  return rules.join("");
}

export function WorldMap({ items }: { items: readonly AltPegLinkHubItem[] }) {
  const fills = buildCountryColorMap(items);
  const styleBlock = buildStyleBlock(fills);

  return (
    <div
      className="fiat-world-map relative w-full"
      aria-label="World map showing tracked fiat peg reference regions"
    >
      <style>{styleBlock}</style>
      <div
        className="[&_svg]:h-auto [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: WORLD_SVG }}
      />
    </div>
  );
}
