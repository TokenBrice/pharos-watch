import { describe, expect, it } from "vitest";
import {
  isOpsPath,
} from "@/lib/admin-workspaces";

describe("admin workspace registry", () => {
  it("matches only the exact admin route families as ops paths", () => {
    for (const pathname of [
      "/admin",
      "/admin/",
      "/admin/pipeline",
      "/admin/pipeline/details/",
      "/admin-api",
      "/admin-api/",
      "/admin-api/audit",
    ]) {
      expect(isOpsPath(pathname), pathname).toBe(true);
    }

    for (const pathname of [
      "/",
      "/administrator",
      "/administrator/tools",
      "/administer",
      "/admin-apiary",
      "/admin_api",
      "/foo/admin",
      null,
      undefined,
    ]) {
      expect(isOpsPath(pathname), String(pathname)).toBe(false);
    }
  });
});
