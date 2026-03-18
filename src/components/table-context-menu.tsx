"use client";

import { useState, useCallback, useEffect } from "react";
import {
  ExternalLink,
  Copy,
  BarChart3,
  Scale,
  Bell,
  Share2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ContextMenuItem {
  id: string;
  label: string;
  icon: typeof ExternalLink;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}

interface TableContextMenuProps {
  items: ContextMenuItem[];
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
}

export function TableContextMenu({
  items,
  isOpen,
  position,
  onClose,
}: TableContextMenuProps) {
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside() {
      onClose();
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    // Close on any click or escape
    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-lg border border-border/70 bg-card/95 p-1 shadow-xl backdrop-blur animate-in fade-in zoom-in-95 duration-100"
      style={{
        left: position.x,
        top: position.y,
      }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
    >
      {items.map((item, index) => {
        const Icon = item.icon;

        return (
          <button
            key={item.id}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={cn(
              "pharos-focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
              item.disabled
                ? "cursor-not-allowed opacity-50"
                : "hover:bg-muted/60"
            )}
          >
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <kbd className="rounded border border-border/60 bg-muted/50 px-1 py-0.5 text-xs font-mono text-muted-foreground">
                {item.shortcut}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Hook to manage context menu state
export function useContextMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const open = useCallback((x: number, y: number) => {
    setPosition({ x, y });
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  return { isOpen, position, open, close };
}
