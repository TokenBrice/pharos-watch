// Stub for harfbuzzjs: Wrangler aliases it to src/lib/og-harfbuzz.ts (Worker WASM), which
// Node vitest cannot load, and the real package's Promise export makes Vite's module
// namespace thenable. Building a measurer from this stub fails closed, like satori-stub.
export const __stub = true;
export default { __stub: true };
