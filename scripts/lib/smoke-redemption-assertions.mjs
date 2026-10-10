/** Canonical response validation plus deliberately stricter smoke wire checks. */
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { assert } from "./smoke-runtime.mjs";

export function assertRedemptionResponse(body) {
  const pathPrefix = "/api/redemption-backstops";
  const result = RedemptionBackstopsResponseSchema.safeParse(body);
  assert(
    result.success,
    result.success ? "" : result.error.issues.map((issue) =>
      `${pathPrefix}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`,
    ).join("; "),
  );

  // Inspect the raw wire payload: schema defaults must not conceal omitted fields.
  const entries = Object.entries(body.coins);
  assert(entries.length > 0, `${pathPrefix} returned empty coins map`);
  assert(body.methodology.version.length > 0, `${pathPrefix} missing methodology.version`);
  for (const [key, entry] of entries) {
    const entryPath = `${pathPrefix} coins.${key}`;
    assert(entry.stablecoinId === key, `${entryPath}.stablecoinId does not match map key`);
    for (const field of ["routeStatus", "routeStatusSource", "holderEligibility"]) {
      assert(entry[field] !== undefined, `${entryPath}.${field} is missing`);
    }
    for (const field of ["provider", "methodologyVersion"]) {
      assert(entry[field].length > 0, `${entryPath}.${field} is invalid`);
    }
    for (const [index, source] of (entry.docs?.sources ?? []).entries()) {
      assert(source.label.length > 0, `${entryPath}.docs.sources[${index}].label is invalid`);
    }
  }
  return entries.length;
}
