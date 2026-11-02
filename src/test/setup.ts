import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

/**
 * One async-utility budget for the whole `src` project.
 *
 * Testing Library defaults every `findBy*`/`waitFor*` query to 1000 ms, which is
 * below what these jsdom suites need on a loaded CI runner: a single file can
 * mount 58 cases, and a healthy `findByRole` on a large tree has timed out at the
 * default (`src/app/pharoswatchbot/app/page.test.tsx`, "keeps last-known state
 * read-only through a refresh failure until retry"). The project-level budget and
 * its 3000 ms query wait replace per-call overrides (the 20 s `testTimeout` is
 * unchanged); a
 * genuine hang still fails with the same query error, three seconds later. A case
 * that needs longer passes its own explicit timeout.
 */
configure({ asyncUtilTimeout: 3000 });

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
