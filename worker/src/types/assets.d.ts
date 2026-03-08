declare module "*.ttf" {
  const content: ArrayBuffer;
  export default content;
}

declare module "*.wasm" {
  const content: WebAssembly.Module;
  export default content;
}
