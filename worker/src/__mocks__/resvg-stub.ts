// Stub for @resvg/resvg-wasm — prevents WASM loading in vitest
export class Resvg {
  render() {
    return { asPng: () => new Uint8Array() };
  }
}
export function initWasm() {}
const wasmStub = new ArrayBuffer(0);
export default wasmStub;
