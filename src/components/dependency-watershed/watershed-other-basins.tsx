import { formatHubDirect } from "@/lib/dependency-watershed/known";
import type { WatershedReadyModel } from "./watershed-stage";

export function WatershedOtherBasins({ model, labelOf, roots, onCommit }: {
  model: WatershedReadyModel;
  labelOf: (id: string) => string;
  roots: ReadonlySet<string>;
  onCommit: (id: string) => void;
}) {
  if (!model.otherBasins.length) return null;
  return (
    <section aria-labelledby="watershed-other-basins" className="space-y-2">
      <h3 id="watershed-other-basins" className="pharos-label">Other basins ({model.otherBasins.length}) · not linked to the main network</h3>
      <ul className="flex flex-wrap gap-2">
        {model.otherBasins.flatMap(basin => basin.hubs.map(hub => {
          const names = hub.dependents.slice(0, 3).map(fact => labelOf(fact.to)).join(", ");
          return (
            <li key={hub.id}>
              <button
                type="button"
                aria-pressed={roots.has(hub.id)}
                onClick={() => onCommit(hub.id)}
                className={roots.has(hub.id) ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active min-h-11 px-3 text-left text-xs" : "pharos-focus-ring pharos-control-pill min-h-11 px-3 text-left text-xs"}
              >
                <span className="font-semibold">{labelOf(hub.id)}</span>
                <span aria-hidden="true"> → </span>
                <span>{names}{hub.dependents.length > 3 ? ` +${hub.dependents.length - 3}` : ""}</span>
                <span className="pharos-numeric ml-2 text-muted-foreground">{formatHubDirect(hub.exposure, hub.dependents.map(fact => fact.edge), "USD n/a")}</span>
              </button>
            </li>
          );
        }))}
      </ul>
    </section>
  );
}
