export function isHardReloadableRouteError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const combined = `${error.name} ${error.message}`.toLowerCase();

  return [
    "chunkloaderror",
    "loading chunk",
    "failed to fetch dynamically imported module",
    "failed to load module script",
    "importing a module script failed",
    "failed to load css chunk",
  ].some((pattern) => combined.includes(pattern));
}
