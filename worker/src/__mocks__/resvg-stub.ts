// Stub for resvg WASM — prevents WASM loading in vitest
export class Resvg {
  render() {
    return { asPng: () => new Uint8Array() };
  }
}
export function initWasm() {}
export function initResvg() {}
export const resvgWasmModule = {};
const wasmStub = new ArrayBuffer(0);
export default wasmStub;
