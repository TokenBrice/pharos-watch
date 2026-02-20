"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const STORAGE_KEY = "pharos-intro-collapsed";

interface CollapsibleIntroProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

export function CollapsibleIntro({ title, subtitle, children }: CollapsibleIntroProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) {
      setCollapsed(false); // First visit: expanded
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) {
      localStorage.setItem(STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  if (!mounted) {
    return (
      <div className="space-y-2 mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground">{subtitle}</p>
        {children}
      </div>
    );
  }

  return (
    <div className="space-y-2 mb-6">
      <div className="flex items-center gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <button
          onClick={toggle}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={collapsed ? "Expand description" : "Collapse description"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
        </button>
      </div>
      <p className="text-muted-foreground">{subtitle}</p>
      {!collapsed && children}
    </div>
  );
}
