import { runReadOnlyStatusCallback } from "./read-only-status-callback";
import type { CallbackHandler } from "./_shared";

export const handleStatusCallback: CallbackHandler = (ctx) => runReadOnlyStatusCallback(ctx, "status");
