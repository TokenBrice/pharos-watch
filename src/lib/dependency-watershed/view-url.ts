import { DEFAULT_NODE_LIMIT } from "@/lib/contagion-graph-constants";

export type DependencyMapView = "watershed" | "network";

/**
 * Explore parameters only the Network view reads, such as the coin-page `?focus=<id>` deep link, with the value the
 * Network writes when untouched. Default values are not a request for Network,
 * otherwise reloading after a Network visit would override the Watershed default.
 */
const NETWORK_PARAM_DEFAULTS = { focus: "all", trace: null, type: "all", limit: String(DEFAULT_NODE_LIMIT) } as const;

function hasNetworkParams(params: URLSearchParams): boolean {
  return Object.entries(NETWORK_PARAM_DEFAULTS).some(([name, fallback]) => params.has(name) && params.get(name) !== fallback);
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
