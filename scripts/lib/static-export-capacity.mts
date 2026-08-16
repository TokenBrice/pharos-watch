const ROUTE_FAMILY_MATCHERS = [
  {
    family: "stablecoin-yield",
    match: (path: string) => /^stablecoin\/([^/]+)\/yield\//.exec(path),
  },
  {
    family: "stablecoin-detail",
    match: (path: string) => /^stablecoin\/([^/]+)\/[^/]+$/.exec(path),
  },
  {
    family: "depeg-event",
    match: (path: string) => /^depeg\/([^/]+)\//.exec(path),
  },
  {
    family: "digest-detail",
    match: (path: string) => /^digest\/([^/]+)\//.exec(path),
  },
] as const;

type RouteFamily = (typeof ROUTE_FAMILY_MATCHERS)[number]["family"];

interface StaticRouteFile {
  rel: string;
  size: number;
}

interface ClassifiedRoute {
  family: RouteFamily;
  routeKey: string;
}

function normalizeOutPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^out\//, "");
}

export function classifyStaticRouteFile(path: string): ClassifiedRoute | null {
  const normalized = normalizeOutPath(path);
  for (const matcher of ROUTE_FAMILY_MATCHERS) {
    const match = matcher.match(normalized);
    if (match) return { family: matcher.family, routeKey: match[1] };
  }
  return null;
}

export function summarizeStaticRouteFamilies(files: readonly StaticRouteFile[]): Array<{
  family: RouteFamily;
  routeCount: number;
  fileCount: number;
  totalBytes: number;
  averageFilesPerRoute: number;
  averageBytesPerRoute: number;
}> {
  const groups = new Map<RouteFamily, {
    family: RouteFamily;
    routeKeys: Set<string>;
    fileCount: number;
    totalBytes: number;
  }>();
  for (const file of files) {
    const classified = classifyStaticRouteFile(file.rel);
    if (!classified) continue;
    const group = groups.get(classified.family) ?? {
      family: classified.family,
      routeKeys: new Set(),
      fileCount: 0,
      totalBytes: 0,
    };
    group.routeKeys.add(classified.routeKey);
    group.fileCount += 1;
    group.totalBytes += file.size;
    groups.set(classified.family, group);
  }

  return [...groups.values()]
    .map((group) => ({
      family: group.family,
      routeCount: group.routeKeys.size,
      fileCount: group.fileCount,
      totalBytes: group.totalBytes,
      averageFilesPerRoute: group.routeKeys.size > 0 ? group.fileCount / group.routeKeys.size : 0,
      averageBytesPerRoute: group.routeKeys.size > 0 ? group.totalBytes / group.routeKeys.size : 0,
    }))
    .sort((left, right) => right.fileCount - left.fileCount || left.family.localeCompare(right.family));
}

export function projectStaticRouteCapacity({
  totalFiles,
  fileLimit,
  minimumHeadroomRatio,
  averageFilesPerRoute,
}: {
  totalFiles: number;
  fileLimit: number;
  minimumHeadroomRatio: number;
  averageFilesPerRoute: number;
}): {
  fileHeadroom: number;
  headroomRatio: number;
  targetMaximumFiles: number;
  filesUntilHeadroomFloor: number;
  routesUntilHardLimit: number;
  routesUntilHeadroomFloor: number;
} {
  const fileHeadroom = Math.max(0, fileLimit - totalFiles);
  const headroomRatio = fileLimit > 0 ? fileHeadroom / fileLimit : 0;
  const targetMaximumFiles = Math.floor(fileLimit * (1 - minimumHeadroomRatio));
  const filesUntilHeadroomFloor = targetMaximumFiles - totalFiles;
  const routesUntilHardLimit = averageFilesPerRoute > 0
    ? Math.floor(fileHeadroom / averageFilesPerRoute)
    : 0;
  const routesUntilHeadroomFloor = averageFilesPerRoute > 0
    ? Math.floor(filesUntilHeadroomFloor / averageFilesPerRoute)
    : 0;
  return {
    fileHeadroom,
    headroomRatio,
    targetMaximumFiles,
    filesUntilHeadroomFloor,
    routesUntilHardLimit,
    routesUntilHeadroomFloor,
  };
}

export function countDocumentsReferencingChunks(documents: readonly string[], chunkNames: readonly string[]): number {
  const names = [...new Set(chunkNames)].filter(Boolean);
  if (names.length === 0) return 0;

  let count = 0;
  for (const document of documents) {
    if (names.some((name) => document.includes(name))) count += 1;
  }
  return count;
}
