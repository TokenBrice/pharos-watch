"use client";

import { useEffect, type ReactNode } from "react";
import { getApiDocumentRedirect, type ApiDocument } from "@/lib/api-document-navigation";

/** Legacy /api/#reference and endpoint fragments still resolve after the document split. */
export function ApiTabs({ active, children }: { active: ApiDocument; children: ReactNode }) {
  useEffect(() => {
    const sync = () => {
      const redirect = getApiDocumentRedirect(active, window.location.hash, (id) => document.getElementById(id) !== null);
      if (redirect) window.location.replace(redirect);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [active]);

  return (
    <div className="space-y-8">
      <nav aria-label="API page sections" className="flex flex-wrap gap-2 border-b border-border/55 pb-3">
        {(["access", "reference"] as const).map((tab) => (
          <a
            key={tab}
            href={tab === "access" ? "/api/#access" : "/api/reference/#reference"}
            aria-current={active === tab ? "page" : undefined}
            data-state={active === tab ? "on" : "off"}
            className="pharos-toggle-pill pharos-focus-ring min-h-11 px-4 md:min-h-9"
          >
            {tab === "access" ? "Access" : "Reference"}
          </a>
        ))}
      </nav>
      <div id={active} className="scroll-mt-20">{children}</div>
    </div>
  );
}
