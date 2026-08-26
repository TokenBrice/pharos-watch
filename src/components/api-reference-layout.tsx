"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ApiReferenceSidebar, type SidebarSection } from "@/components/api-reference-sidebar";
import { ApiReferenceMobileNav } from "@/components/api-reference-mobile-nav";

const SCROLL_OFFSET = 96;

interface ApiReferenceLayoutProps {
  sections: SidebarSection[];
  children: ReactNode;
}

export function ApiReferenceLayout({ sections, children }: ApiReferenceLayoutProps) {
  const allIds = useMemo(
    () => sections.flatMap((s) => [s.id, ...s.subsections.map((sub) => sub.id)]),
    [sections],
  );
  const idSignature = allIds.join("|");
  const [activeId, setActiveId] = useState(allIds[0] ?? "");
  const sidebarRef = useRef<HTMLDivElement>(null);
  const initialHashHandled = useRef(false);

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const top = window.scrollY + el.getBoundingClientRect().top - SCROLL_OFFSET;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    window.history.pushState(null, "", `#${id}`);
    setActiveId(id);
  }, []);

  // Scrollspy
  useEffect(() => {
    const ids = idSignature.split("|");
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (nodes.length === 0) return;

    // Set scroll-margin-top on all observed elements
    for (const node of nodes) {
      node.style.scrollMarginTop = `${SCROLL_OFFSET}px`;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-10% 0px -70% 0px", threshold: [0.05, 0.2, 0.4] },
    );

    for (const node of nodes) observer.observe(node);

    // Handle initial hash
    if (!initialHashHandled.current) {
      initialHashHandled.current = true;
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (hash && ids.includes(hash)) {
        requestAnimationFrame(() => {
          setActiveId(hash);
          const el = document.getElementById(hash);
          if (el) {
            const top = window.scrollY + el.getBoundingClientRect().top - SCROLL_OFFSET;
            window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
          }
        });
      }
    }

    return () => {
      observer.disconnect();
      for (const node of nodes) {
        node.style.scrollMarginTop = "";
      }
    };
  }, [idSignature]);

  // Auto-scroll sidebar to keep active item visible
  useEffect(() => {
    if (!sidebarRef.current) return;
    const activeEl = sidebarRef.current.querySelector(`[data-sidebar-id="${activeId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeId]);

  return (
    <>
      <ApiReferenceMobileNav sections={sections} activeId={activeId} onNavigate={scrollToId} />
      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8">
        <div
          ref={sidebarRef}
          className="hidden lg:sticky lg:top-4 lg:block lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:overscroll-contain lg:pb-8 lg:scrollbar-thin lg:scrollbar-track-transparent lg:scrollbar-thumb-border/40"
        >
          <ApiReferenceSidebar sections={sections} activeId={activeId} onNavigate={scrollToId} />
        </div>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </>
  );
}
