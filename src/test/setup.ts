import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * DOM unmount only, replacing the per-file `afterEach(() => cleanup())` blocks.
 *
 * Global stubs and fake timers stay suite-owned. A global `vi.unstubAllGlobals()`
 * would tear down a `beforeAll`-installed stub after the file's first test, and a
 * global `vi.useRealTimers()` would do the same to suite-level fake timers. Suites
 * that want that fuller reset call `cleanupFrontendTest()` from `@/test-utils/frontend`
 * in their own hook.
 */
afterEach(cleanup);
