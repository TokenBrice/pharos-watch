// harfbuzzjs ships no types; worker/src/lib/og-harfbuzz.ts uses only these entry points.
declare module "harfbuzzjs/hb.js" {
  type WasmCallback = (...args: number[]) => unknown;
  interface HarfBuzzModuleArg {
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ): object;
  }
  export interface HarfBuzzModule {
    addFunction(fn: WasmCallback, signature: string): number;
    wasmExports: { free: WasmCallback };
  }
  const createHarfBuzz: (moduleArg: HarfBuzzModuleArg) => Promise<HarfBuzzModule>;
  export default createHarfBuzz;
}

declare module "harfbuzzjs/hbjs.js" {
  import type { HarfBuzzModule } from "harfbuzzjs/hb.js";
  const hbjs: (module: HarfBuzzModule) => unknown;
  export default hbjs;
}
