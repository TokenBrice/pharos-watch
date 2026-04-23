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
    `.fiat-world-map{--world-default-fill:oklch(0.22 0.012 248 / 0.95);--world-stroke:oklch(0.45 0.02 248 / 0.55)}`,
    `.fiat-world-map .world-countries path{transition:fill 180ms ease}`,
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
