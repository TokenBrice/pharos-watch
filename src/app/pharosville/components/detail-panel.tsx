"use client";

import type { DetailModel } from "../systems/world-types";

type FactGroup = {
  id: "facts" | "route" | "source";
  title: string;
  facts: DetailModel["facts"];
};

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
  const factGroups = groupFacts(detail.facts);

  return (
    <aside
      id={panelId}
      className="pharosville-detail-panel"
      aria-labelledby={headingId}
      aria-live="polite"
      data-testid="pharosville-detail-panel"
    >
      <header className="pharosville-detail-panel__header">
        <p className="pharosville-detail-panel__kind">{detail.kind}</p>
        <h2 id={headingId}>{detail.title}</h2>
        <p>{detail.summary}</p>
      </header>

      {factGroups.map((group) => (
        <section
          key={group.id}
          className={`pharosville-detail-panel__section pharosville-detail-panel__section--${group.id}`}
          aria-label={group.title}
        >
          <h3>{group.title}</h3>
          <dl>
            {group.facts.map((fact) => (
              <div key={`${group.id}-${fact.label}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      {detail.members && detail.members.length > 0 && (
        <section className="pharosville-detail-panel__section pharosville-detail-panel__section--members" aria-label={`${detail.title} members`}>
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
        <nav className="pharosville-detail-panel__section pharosville-detail-panel__section--links" aria-label={`${detail.title} links`}>
          <h3>Links</h3>
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
        <button className="pharosville-detail-panel__close" type="button" onClick={onClose}>
          Close details
        </button>
      )}
    </aside>
  );
}

function groupFacts(facts: DetailModel["facts"]): FactGroup[] {
  const groups: FactGroup[] = [
    { id: "facts", title: "Facts", facts: [] },
    { id: "route", title: "Route", facts: [] },
    { id: "source", title: "Notes", facts: [] },
  ];

  for (const fact of facts) {
    if (isSourceFact(fact.label)) {
      groups[2].facts.push(fact);
    } else if (isRouteFact(fact.label)) {
      groups[1].facts.push(fact);
    } else {
      groups[0].facts.push(fact);
    }
  }

  return groups.filter((group) => group.facts.length > 0);
}

function isRouteFact(label: string): boolean {
  return /route|risk|dock|chain|position|cadence|deployment/i.test(label);
}

function isSourceFact(label: string): boolean {
  return /source|evidence|caveat/i.test(label);
}
