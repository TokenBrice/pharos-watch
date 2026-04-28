"use client";

import type { DetailModel } from "../systems/world-types";

export interface DetailPanelProps {
  detail: DetailModel;
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
          <h3>{detail.membersHeading ?? "Members"}</h3>
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
    </aside>
  );
}
