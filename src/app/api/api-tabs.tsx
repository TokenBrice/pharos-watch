"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export const API_TAB_IDS = { access: "access", reference: "reference" } as const;
type ApiTab = keyof typeof API_TAB_IDS;

const TABS: readonly { id: ApiTab; label: string }[] = [
  { id: "access", label: "Access" },
  { id: "reference", label: "Reference" },
];

/** The tab that owns a URL hash: the tab id itself, or the panel containing that anchor. */
function tabForHash(hash: string, panels: Record<ApiTab, HTMLElement | null>): ApiTab | null {
  let id = "";
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  if (!id) return null;
  if (id === API_TAB_IDS.access || id === API_TAB_IDS.reference) return id;
  const target = document.getElementById(id);
  if (!target) return null;
  if (panels.reference?.contains(target)) return "reference";
  if (panels.access?.contains(target)) return "access";
  return null;
}

/**
 * Hash-addressed tabs for the static /api/ page. Both panels are in the
 * exported HTML; `#reference` (or any anchor inside the reference panel, such
 * as `#polling-guidance`) selects Reference, everything else shows Access.
 * No inline script: selection runs in this client component after hydration.
 */
export function ApiTabs({ access, reference }: { access: ReactNode; reference: ReactNode }) {
  const [active, setActive] = useState<ApiTab>("access");
  const accessRef = useRef<HTMLDivElement | null>(null);
  const referenceRef = useRef<HTMLDivElement | null>(null);

  // Anchor to reveal once its panel is visible (it was hidden at load, so the
  // browser could not scroll to it).
  const pendingAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    const sync = () => {
      const panels = { access: accessRef.current, reference: referenceRef.current };
      const tab = tabForHash(window.location.hash, panels);
      if (!tab) return;
      setActive(tab);
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (id !== API_TAB_IDS.access && id !== API_TAB_IDS.reference) pendingAnchorRef.current = id;
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    const id = pendingAnchorRef.current;
    const target = id ? document.getElementById(id) : null;
    // Wait for the commit that unhides the target's panel.
    if (!id || !target || target.closest("[hidden]")) return;
    pendingAnchorRef.current = null;
    // Re-align while late layout (fonts, tables) settles below the fold.
    const timers = [0, 160, 480, 960].map((delay) =>
      window.setTimeout(() => document.getElementById(id)?.scrollIntoView(), delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [active]);

  return (
    <div className="space-y-8">
      <div role="tablist" aria-label="API page sections" className="flex flex-wrap gap-2 border-b border-border/55 pb-3">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            role="tab"
            id={`${tab.id}-tab`}
            href={`#${API_TAB_IDS[tab.id]}`}
            aria-selected={active === tab.id}
            aria-controls={API_TAB_IDS[tab.id]}
            data-state={active === tab.id ? "on" : "off"}
            onClick={(event) => {
              event.preventDefault();
              window.history.replaceState(null, "", `#${API_TAB_IDS[tab.id]}`);
              setActive(tab.id);
            }}
            className="pharos-toggle-pill pharos-focus-ring min-h-11 px-4 md:min-h-9"
          >
            {tab.label}
          </a>
        ))}
      </div>
      <div
        ref={accessRef}
        id={API_TAB_IDS.access}
        role="tabpanel"
        aria-labelledby="access-tab"
        hidden={active !== "access"}
        className="scroll-mt-20"
      >
        {access}
      </div>
      <div
        ref={referenceRef}
        id={API_TAB_IDS.reference}
        role="tabpanel"
        aria-labelledby="reference-tab"
        hidden={active !== "reference"}
        className="scroll-mt-20"
      >
        {reference}
      </div>
    </div>
  );
}
