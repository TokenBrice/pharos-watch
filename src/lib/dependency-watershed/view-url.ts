export type DependencyMapView = "watershed" | "network";

/** Explore parameters only the Network view reads, such as the coin-page `?focus=<id>` deep link. */
const NETWORK_PARAMS = ["focus", "trace", "type", "limit"] as const;

function hasNetworkParams(params: URLSearchParams): boolean {
  return NETWORK_PARAMS.some(name => params.has(name));
}

/** Watershed is the default unless the URL asks for Network or carries Network-only Explore state. */
export function readDependencyMapView(search: string): DependencyMapView {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "network" || view === "watershed") return view;
  return hasNetworkParams(params) ? "network" : "watershed";
}

/** Writes `view` only when the default would read differently; other parameters are preserved. */
export function writeDependencyMapView(search: string, view: DependencyMapView): string {
  const params = new URLSearchParams(search);
  params.delete("view");
  if (view === "network" || hasNetworkParams(params)) params.set("view", view);
  const query = params.toString();
  return query ? `?${query}` : "";
}
