import type { Env } from "../lib/env";
import { handleHttpRequestImpl } from "./http/request-dispatch";

export async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return handleHttpRequestImpl(request, env, ctx);
}
