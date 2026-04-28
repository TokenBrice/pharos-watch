"use client";

import type { PharosVilleWorld } from "../systems/world-types";

type PharosVilleEntity =
  | PharosVilleWorld["lighthouse"]
  | PharosVilleWorld["docks"][number]
  | PharosVilleWorld["ships"][number]
  | PharosVilleWorld["shipClusters"][number]
  | PharosVilleWorld["graves"][number];

interface BrowserEntity {
  detailId: string;
  id: string;
  kind: PharosVilleEntity["kind"];
  label: string;
}

export interface KeyboardEntityBrowserProps {
  world: PharosVilleWorld;
  selectedDetailId?: string | null;
  headingId?: string;
  detailPanelId?: string;
  onSelectDetail?: (detailId: string) => void;
}

export function KeyboardEntityBrowser({
  world,
  selectedDetailId,
  headingId = "pharosville-entity-browser-title",
  detailPanelId = "pharosville-detail-panel",
  onSelectDetail,
}: KeyboardEntityBrowserProps) {
  const entities = collectEntities(world);

  return (
    <section aria-labelledby={headingId} data-testid="pharosville-keyboard-entity-browser">
      <h2 id={headingId}>Map entities</h2>
      <ol>
        {entities.map((entity) => {
          const active = selectedDetailId === entity.detailId;
          const label = `${entity.kind}: ${entity.label}`;
          return (
            <li key={`${entity.kind}.${entity.id}`}>
              {onSelectDetail ? (
                <button
                  type="button"
                  aria-controls={detailPanelId}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelectDetail(entity.detailId)}
                >
                  {label}
                </button>
              ) : (
                <a href={`#${entity.detailId}`} aria-current={active ? "true" : undefined}>
                  {label}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function collectEntities(world: PharosVilleWorld): BrowserEntity[] {
  return [world.lighthouse, ...world.docks, ...world.ships, ...world.shipClusters, ...world.graves].map((entity) => ({
    detailId: entity.detailId,
    id: entity.id,
    kind: entity.kind,
    label: entity.label,
  }));
}
