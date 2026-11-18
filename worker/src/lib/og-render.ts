import satori, { init as initSatori } from "satori/standalone";
import yogaWasm from "satori/yoga.wasm";
import { Resvg, initResvg, resvgWasmModule } from "@cf-wasm/resvg/workerd";
// Satori shapes with this same instance: wrangler aliases harfbuzzjs to ./og-harfbuzz.ts.
import harfBuzz from "harfbuzzjs";
import type { SocialCardElement } from "@shared/lib/social-card/parts";
import { createSocialCardMeasurer, type HarfBuzzApi, type SocialCardMeasurer } from "@shared/lib/social-card/text";
import { SOCIAL_PREVIEW_WIDTH, SOCIAL_PREVIEW_HEIGHT } from "@shared/lib/social-preview";
import { OG_FONTS, SCORECARD_FONT_BYTES } from "./og-fonts";

// Intentional per-isolate cache: initialize WASM once, retry only failed initialization.
let wasmInitialization: Promise<void> | null = null;
// One measurer per isolate: its HarfBuzz faces live as long as the isolate, so it is never rebuilt per request.
let scorecardMeasurer: Promise<SocialCardMeasurer> | null = null;

async function ensureWasm(): Promise<void> {
  if (!wasmInitialization) {
    wasmInitialization = (async () => {
      const errors: unknown[] = [];
      try {
        await initSatori(yogaWasm);
      } catch (error: unknown) {
        if (!(error instanceof Error && error.message.includes("already"))) errors.push(error);
      }
      try {
        await initResvg(resvgWasmModule);
      } catch (error: unknown) {
        if (!(error instanceof Error && error.message.includes("already called"))) errors.push(error);
      }
      if (errors.length > 0) throw errors[0];
    })().catch((error) => {
      wasmInitialization = null;
      throw error;
    });
  }
  await wasmInitialization;
}

/** Real-metric text fitting for the social-card templates, on the faces OG_FONTS registers. */
export function socialCardMeasurer(): Promise<SocialCardMeasurer> {
  scorecardMeasurer ??= (async () => createSocialCardMeasurer(await (harfBuzz as unknown as HarfBuzzApi | Promise<HarfBuzzApi>), SCORECARD_FONT_BYTES))()
    .catch((error: unknown) => {
      scorecardMeasurer = null;
      throw error;
    });
  return scorecardMeasurer;
}

export async function renderPng(element: SocialCardElement): Promise<Uint8Array> {
  await ensureWasm();
  const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
    width: SOCIAL_PREVIEW_WIDTH,
    height: SOCIAL_PREVIEW_HEIGHT,
    fonts: OG_FONTS,
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: SOCIAL_PREVIEW_WIDTH } });
  return resvg.render().asPng();
}
