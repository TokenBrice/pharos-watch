import { errorResponse } from "./api-response";
import { resolveOrReject } from "./api-params";

export function readCoinProjectionId(url: URL): string | Response {
  const values = url.searchParams.getAll("stablecoin");
  if (values.length !== 1 || !values[0]) {
    return errorResponse(400, "Expected one ?stablecoin= parameter", { noStore: true });
  }
  const resolved = resolveOrReject(values[0]);
  return resolved instanceof Response ? resolved : resolved.canonicalId;
}
