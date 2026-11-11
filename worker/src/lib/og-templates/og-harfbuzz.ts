// satori >=0.33.5 shapes text with HarfBuzz through harfbuzzjs, whose loader
// cannot start in workerd: under nodejs_compat it takes its Node branch and
// reads __filename/__dirname, then compiles hb.wasm from bytes. worker/wrangler.toml
// aliases the bare "harfbuzzjs" import to this module, which instantiates the
// bundled CompiledWasm module instead. It loads with the OG route, inside a
// request, where workerd forbids all Wasm code generation.
import createHarfBuzz from "harfbuzzjs/hb.js";
import hbjs from "harfbuzzjs/hbjs.js";
import hbWasm from "harfbuzzjs/hb.wasm";

// The loader reads both names synchronously while it starts, so they exist only
// for that call.
const missing = ["__filename", "__dirname"].filter((name) => !(name in globalThis));
for (const name of missing) Object.defineProperty(globalThis, name, { value: "/", configurable: true });
let starting: ReturnType<typeof createHarfBuzz>;
try {
  starting = createHarfBuzz({
    instantiateWasm(imports, receive) {
      receive(new WebAssembly.Instance(hbWasm, imports), hbWasm);
      return {};
    },
  });
} finally {
  for (const name of missing) Reflect.deleteProperty(globalThis, name);
}
const harfBuzz = await starting;

// hbjs first registers a "vi" callback that only forwards to the module's own
// free(). Registering that Wasm export directly avoids compiling a JS-to-Wasm
// trampoline; later registrations (glyph drawing, unused by satori) are untouched.
const addFunction = harfBuzz.addFunction;
let freeRegistered = false;
harfBuzz.addFunction = (fn, signature) => {
  if (freeRegistered || signature !== "vi") return addFunction(fn, signature);
  freeRegistered = true;
  return addFunction(harfBuzz.wasmExports.free, signature);
};

export default hbjs(harfBuzz);
