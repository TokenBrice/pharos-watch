import { describe, expect, it } from "vitest";
import { PRICE_SOURCE_HEALTH_BUCKET_KEYS as RUNTIME_PRICE_SOURCE_HEALTH_BUCKET_KEYS } from "../../lib/pricing-sources";
import { PRICE_SOURCE_HEALTH_BUCKET_KEYS } from "../pricing-source-health";

describe("PRICE_SOURCE_HEALTH_BUCKET_KEYS", () => {
  it("stays aligned with the runtime pricing-source health buckets", () => {
    expect(PRICE_SOURCE_HEALTH_BUCKET_KEYS).toEqual(RUNTIME_PRICE_SOURCE_HEALTH_BUCKET_KEYS);
  });
});
