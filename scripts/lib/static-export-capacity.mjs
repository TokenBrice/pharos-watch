const ROUTE_FAMILY_MATCHERS = [
  {
    family: "stablecoin-yield",
    match: (path) => /^stablecoin\/([^/]+)\/yield\//.exec(path),
  },
  {
    family: "stablecoin-detail",
    match: (path) => /^stablecoin\/([^/]+)\/[^/]+$/.exec(path),
  },
  {
    family: "depeg-event",
    match: (path) => /^depeg\/([^/]+)\//.exec(path),
  },
  {
    family: "digest-detail",
    match: (path) => /^digest\/([^/]+)\//.exec(path),
  },
];

function normalizeOutPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^out\//, "");
}

export function classifyStaticRouteFile(path) {
  const normalized = normalizeOutPath(path);
  for (const matcher of ROUTE_FAMILY_MATCHERS) {
    const match = matcher.match(normalized);
    if (match) return { family: matcher.family, routeKey: match[1] };
  }
  return null;
}

export function summarizeStaticRouteFamilies(files) {
  const groups = new Map();
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
}) {
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
