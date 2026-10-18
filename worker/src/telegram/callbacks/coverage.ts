import { runReadOnlyStatusCallback } from "./read-only-status-callback";
import type { CallbackHandler } from "./_shared";

export const handleCoverageCallback: CallbackHandler = (ctx) => runReadOnlyStatusCallback(ctx, "coverage");
