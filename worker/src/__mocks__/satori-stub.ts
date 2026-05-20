// Stub for satori/standalone — prevents yoga WASM loading in vitest
export const __stub = true;
export async function init() {}
export default async function satori() {
  return "<svg></svg>";
}
