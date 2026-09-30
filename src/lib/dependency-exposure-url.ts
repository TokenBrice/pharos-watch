export interface DependencyExposureUrlState {
  mode: "explore" | "exposure";
  roots: string[];
}

export function readDependencyExposureUrl(search: string): DependencyExposureUrlState {
  const params = new URLSearchParams(search);
  return { mode: params.get("mode") === "exposure" ? "exposure" : "explore", roots: [...new Set(params.getAll("root").filter(Boolean))] };
}

export function writeDependencyExposureUrl(search: string, state: DependencyExposureUrlState): string {
  const params = new URLSearchParams(search);
  params.delete("mode");
  params.delete("root");
  if (state.mode === "exposure") params.set("mode", "exposure");
  for (const root of new Set(state.roots)) if (root) params.append("root", root);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function resetDependencyExposureUrl(search: string): string {
  return writeDependencyExposureUrl(search, { mode: "explore", roots: [] });
}
