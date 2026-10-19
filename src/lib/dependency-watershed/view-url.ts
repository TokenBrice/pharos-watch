export type DependencyMapView = "watershed" | "network";

/** Network is the default; only an explicit `view=watershed` opens the Watershed. */
export function readDependencyMapView(search: string): DependencyMapView {
  return new URLSearchParams(search).get("view") === "watershed" ? "watershed" : "network";
}

/** Writes `view` only for the non-default Watershed; other parameters are preserved. */
export function writeDependencyMapView(search: string, view: DependencyMapView): string {
  const params = new URLSearchParams(search);
  params.delete("view");
  if (view === "watershed") params.set("view", view);
  const query = params.toString();
  return query ? `?${query}` : "";
}
