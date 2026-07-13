export const ADMIN_WORKSPACES = [
  {
    id: "triage",
    label: "Triage",
    path: "/admin/",
    legacySectionId: "overview",
  },
  {
    id: "pipeline",
    label: "Pipeline",
    path: "/admin/pipeline/",
    legacySectionId: "pipeline",
  },
  {
    id: "reliability",
    label: "Reliability",
    path: "/admin/reliability/",
    legacySectionId: "reliability",
  },
  {
    id: "crons",
    label: "Crons",
    path: "/admin/crons/",
    legacySectionId: "crons",
  },
  {
    id: "actions",
    label: "Actions",
    path: "/admin/actions/",
    legacySectionId: "actions",
  },
  {
    id: "comms",
    label: "Comms",
    path: "/admin/comms/",
    legacySectionId: "comms",
  },
  {
    id: "history",
    label: "History",
    path: "/admin/history/",
    legacySectionId: "history",
  },
  {
    id: "safety-score-v9",
    label: "Safety V9",
    path: "/admin/safety-score-v9/",
    legacySectionId: "safety-score-v9",
  },
  {
    id: "api-management",
    label: "API Management",
    path: "/admin-api/",
    legacySectionId: "credentials",
  },
] as const;

export type AdminWorkspace = (typeof ADMIN_WORKSPACES)[number];
export type AdminWorkspaceId = AdminWorkspace["id"];
export type LegacyAdminSectionId = AdminWorkspace["legacySectionId"];

const WORKSPACE_BY_ID = new Map<AdminWorkspaceId, AdminWorkspace>(
  ADMIN_WORKSPACES.map((workspace) => [workspace.id, workspace] as const),
);

const WORKSPACE_BY_LEGACY_SECTION = new Map<LegacyAdminSectionId, AdminWorkspace>(
  ADMIN_WORKSPACES.map((workspace) => [workspace.legacySectionId, workspace] as const),
);

function normalizePathname(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const path = pathname.split(/[?#]/, 1)[0];
  if (!path?.startsWith("/")) return null;
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

function isExactOrDescendant(pathname: string, routePath: string): boolean {
  const normalizedRoute = normalizePathname(routePath);
  return normalizedRoute != null && (pathname === normalizedRoute || pathname.startsWith(`${normalizedRoute}/`));
}

export function getAdminWorkspace(id: AdminWorkspaceId): AdminWorkspace {
  const workspace = WORKSPACE_BY_ID.get(id);
  if (!workspace) throw new Error(`Unknown admin workspace: ${id}`);
  return workspace;
}

export function isOpsPath(pathname: string | null | undefined): boolean {
  const normalizedPath = normalizePathname(pathname);
  if (!normalizedPath) return false;
  return isExactOrDescendant(normalizedPath, "/admin/") || isExactOrDescendant(normalizedPath, "/admin-api/");
}

export function isAdminWorkspaceActive(pathname: string | null | undefined, workspaceId: AdminWorkspaceId): boolean {
  const normalizedPath = normalizePathname(pathname);
  if (!normalizedPath) return false;

  const workspace = getAdminWorkspace(workspaceId);
  const normalizedWorkspacePath = normalizePathname(workspace.path);
  if (!normalizedWorkspacePath) return false;

  if (workspace.id === "triage") {
    return normalizedPath === normalizedWorkspacePath;
  }
  return isExactOrDescendant(normalizedPath, normalizedWorkspacePath);
}

export function getActiveAdminWorkspace(pathname: string | null | undefined): AdminWorkspace | null {
  return ADMIN_WORKSPACES.find((workspace) => isAdminWorkspaceActive(pathname, workspace.id)) ?? null;
}

export function getAdminWorkspacePathForLegacyHash(hash: string | null | undefined): AdminWorkspace["path"] | null {
  if (!hash) return null;

  const rawSectionId = hash.startsWith("#") ? hash.slice(1) : hash;
  let sectionId: string;
  try {
    sectionId = decodeURIComponent(rawSectionId);
  } catch {
    return null;
  }

  return WORKSPACE_BY_LEGACY_SECTION.get(sectionId as LegacyAdminSectionId)?.path ?? null;
}
