import type * as React from "react";
import satori, { init as initSatori } from "satori/standalone";
import yogaWasm from "satori/yoga.wasm";
import { Resvg, initResvg, resvgWasmModule } from "@cf-wasm/resvg/workerd";
import { SOCIAL_PREVIEW_WIDTH, SOCIAL_PREVIEW_HEIGHT } from "@shared/lib/social-preview";
import { OG_FONTS } from "./og-fonts";

// Intentional per-isolate cache: initialize WASM once, retry only failed initialization.
let wasmInitialization: Promise<void> | null = null;

/** @internal Reset isolate-local initialization for runtime tests sharing a process. */
export function resetOgWasmInitializationForTests(): void {
  wasmInitialization = null;
}

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

export async function renderPng(element: React.ReactNode): Promise<Uint8Array> {
  await ensureWasm();
  const svg = await satori(element, {
    width: SOCIAL_PREVIEW_WIDTH,
    height: SOCIAL_PREVIEW_HEIGHT,
    fonts: OG_FONTS,
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: SOCIAL_PREVIEW_WIDTH } });
  return resvg.render().asPng();
}
