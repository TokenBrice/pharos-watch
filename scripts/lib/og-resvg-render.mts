import { Resvg } from "@cf-wasm/resvg/node";

/** Exact external executable/WASM closure of @cf-wasm/resvg's Node entry. */
export const OG_RESVG_RUNTIME_SOURCE_PATHS = [
  "node_modules/@cf-wasm/resvg/package.json",
  "node_modules/@cf-wasm/resvg/dist/node.js",
  "node_modules/@cf-wasm/resvg/dist/resvg.js",
  "node_modules/@cf-wasm/resvg/dist/lib/resvg.wasm.inline.js",
  "node_modules/@resvg/resvg-wasm/package.json",
  "node_modules/@resvg/resvg-wasm/index.mjs",
] as const;

export async function renderSvgPngWithResvg({
  svg,
  fontBuffers,
  background,
  width,
}: {
  svg: string;
  fontBuffers: Uint8Array[];
  background: string;
  width: number;
}): Promise<Uint8Array> {
  const renderer = await Resvg.async(svg, {
    fitTo: { mode: "width", value: width },
    background,
    // The WASM engine sees only these buffers, never host-installed fonts.
    font: {
      fontBuffers,
      defaultFontFamily: "Geist",
      sansSerifFamily: "Geist",
      serifFamily: "Newsreader",
      monospaceFamily: "Geist Mono",
    },
  });
  try {
    const image = renderer.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
