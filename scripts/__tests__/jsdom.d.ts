/**
 * Minimal ambient declaration for jsdom, which ships no bundled or @types
 * declarations in this workspace. Covers the surface used by script tests:
 * constructing a document from an SVG/HTML string and reading the window.
 */
declare module "jsdom" {
  export interface JSDOMConstructorOptions {
    contentType?: string;
    url?: string;
  }

  export class JSDOM {
    constructor(html: string, options?: JSDOMConstructorOptions);
    readonly window: Window & typeof globalThis;
  }
}
