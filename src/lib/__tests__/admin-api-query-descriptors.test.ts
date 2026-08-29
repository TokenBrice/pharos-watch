import { describe, expect, it } from "vitest";
import { ADMIN_API_QUERY_DESCRIPTORS } from "@/lib/admin-api-query-descriptors";

describe("admin API query descriptors", () => {
  it("owns status and request-source paths and query keys", () => {
    expect(ADMIN_API_QUERY_DESCRIPTORS.status).toMatchObject({
      queryKey: ["status"],
      path: "/api/status",
    });
    expect(ADMIN_API_QUERY_DESCRIPTORS.requestSourceStats).toMatchObject({
      queryKey: ["request-source-stats", 24, 3600, 5, 25],
      path: "/api/request-source-stats?hours=24&bucketSec=3600&routeLimit=5&apiKeyLimit=25",
    });
  });
});
