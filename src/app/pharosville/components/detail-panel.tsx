"use client";

import type { DetailModel } from "../systems/world-types";

export interface DetailPanelProps {
  detail: DetailModel | null | undefined;
  headingId?: string;
  panelId?: string;
  onClose?: () => void;
}

export function DetailPanel({
  detail,
  headingId = "pharosville-detail-panel-title",
  panelId = "pharosville-detail-panel",
  onClose,
}: DetailPanelProps) {
  return (
    <aside id={panelId} aria-labelledby={headingId} aria-live="polite" data-testid="pharosville-detail-panel">
      {detail ? (
        <>
          <p>{detail.kind}</p>
          <h2 id={headingId}>{detail.title}</h2>
          <p>{detail.summary}</p>

          <dl>
            {detail.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>

          {detail.members && detail.members.length > 0 && (
            <section aria-label={`${detail.title} members`}>
              <h3>Cluster members</h3>
              <ol>
                {detail.members.map((member) => (
                  <li key={member.id}>
                    <a href={member.href}>{member.label}</a>
                    {member.value ? ` ${member.value}` : null}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {detail.links.length > 0 && (
            <nav aria-label={`${detail.title} links`}>
              <ul>
                {detail.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          {onClose && (
            <button type="button" onClick={onClose}>
              Close details
            </button>
          )}
        </>
      ) : (
        <>
          <h2 id={headingId}>No map entity selected</h2>
          <p>Select a lighthouse, dock, ship, cluster, or cemetery marker to inspect its source data.</p>
        </>
      )}
    </aside>
  );
}
