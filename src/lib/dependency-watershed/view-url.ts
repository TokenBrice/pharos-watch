export type DependencyMapView = "watershed" | "network";

/**
 * Watershed is the desktop default (matching content.json prose).
 * Explicit `view=network` (or Network-scoped `focus`/`trace` deep links without
 * an explicit `view=watershed`) opens Network.
 */
export function readDependencyMapView(search: string): DependencyMapView {
  const params = new URLSearchParams(search);
  const explicit = params.get("view");
  if (explicit === "network") return "network";
  if (explicit === "watershed") return "watershed";
  if (params.has("focus") || params.has("trace")) return "network";
  return "watershed";
}

/** Writes `view=network` only for the non-default Network view; other parameters are preserved. */
export function writeDependencyMapView(search: string, view: DependencyMapView): string {
  const params = new URLSearchParams(search);
  params.delete("view");
  if (view === "network") params.set("view", view);
  const query = params.toString();
  return query ? `?${query}` : "";
}
