import { describe, expect, it } from "vitest";
import {
  ADMIN_WORKSPACES,
  getActiveAdminWorkspace,
  getAdminWorkspace,
  getAdminWorkspacePathForLegacyHash,
  isAdminWorkspaceActive,
  isOpsPath,
} from "@/lib/admin-workspaces";

describe("admin workspace registry", () => {
  it("keeps the canonical workspace order, labels, and paths stable", () => {
    expect(ADMIN_WORKSPACES.map(({ id, label, path }) => ({ id, label, path }))).toEqual([
      { id: "triage", label: "Triage", path: "/admin/" },
      { id: "pipeline", label: "Pipeline", path: "/admin/pipeline/" },
      { id: "reliability", label: "Reliability", path: "/admin/reliability/" },
      { id: "crons", label: "Crons", path: "/admin/crons/" },
      { id: "actions", label: "Actions", path: "/admin/actions/" },
      { id: "comms", label: "Comms", path: "/admin/comms/" },
      { id: "history", label: "History", path: "/admin/history/" },
      { id: "api-management", label: "API Management", path: "/admin-api/" },
    ]);
    expect(getAdminWorkspace("pipeline").legacySectionId).toBe("pipeline");
  });

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

  it("matches Triage only at the admin root and named workspaces at route boundaries", () => {
    expect(isAdminWorkspaceActive("/admin", "triage")).toBe(true);
    expect(isAdminWorkspaceActive("/admin/", "triage")).toBe(true);
    expect(isAdminWorkspaceActive("/admin/pipeline", "triage")).toBe(false);

    expect(isAdminWorkspaceActive("/admin/pipeline", "pipeline")).toBe(true);
    expect(isAdminWorkspaceActive("/admin/pipeline/", "pipeline")).toBe(true);
    expect(isAdminWorkspaceActive("/admin/pipeline/details", "pipeline")).toBe(true);
    expect(isAdminWorkspaceActive("/admin/pipelines", "pipeline")).toBe(false);
    expect(isAdminWorkspaceActive("/administrator/pipeline", "pipeline")).toBe(false);

    expect(isAdminWorkspaceActive("/admin-api", "api-management")).toBe(true);
    expect(isAdminWorkspaceActive("/admin-api/audit", "api-management")).toBe(true);
    expect(isAdminWorkspaceActive("/admin-apiary", "api-management")).toBe(false);
  });

  it("resolves the active workspace without assigning unknown nested admin routes to Triage", () => {
    expect(getActiveAdminWorkspace("/admin/")?.id).toBe("triage");
    expect(getActiveAdminWorkspace("/admin/reliability/dependencies")?.id).toBe("reliability");
    expect(getActiveAdminWorkspace("/admin-api/requests")?.id).toBe("api-management");
    expect(getActiveAdminWorkspace("/admin/not-a-workspace")).toBeNull();
    expect(getActiveAdminWorkspace("/administrator")).toBeNull();
  });

  it("maps every legacy dashboard anchor to its workspace route", () => {
    expect(
      Object.fromEntries(
        ["overview", "pipeline", "reliability", "crons", "actions", "comms", "history", "credentials"].map(
          (sectionId) => [sectionId, getAdminWorkspacePathForLegacyHash(`#${sectionId}`)],
        ),
      ),
    ).toEqual({
      overview: "/admin/",
      pipeline: "/admin/pipeline/",
      reliability: "/admin/reliability/",
      crons: "/admin/crons/",
      actions: "/admin/actions/",
      comms: "/admin/comms/",
      history: "/admin/history/",
      credentials: "/admin-api/",
    });
    expect(getAdminWorkspacePathForLegacyHash("pipeline")).toBe("/admin/pipeline/");
    expect(getAdminWorkspacePathForLegacyHash("#not-a-section")).toBeNull();
    expect(getAdminWorkspacePathForLegacyHash("#%E0%A4%A")).toBeNull();
    expect(getAdminWorkspacePathForLegacyHash(null)).toBeNull();
  });
});
