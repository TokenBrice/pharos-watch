declare module "*.ttf" {
  const content: ArrayBuffer;
  export default content;
}

declare module "*.wasm" {
  const content: WebAssembly.Module;
  export default content;
}

// Wrangler's Text rule and Vitest's raw alias expose the same module contract.
declare module "@shared/data/stablecoins/coins.worker-full.generated.json" {
  const content: string;
  export default content;
}
