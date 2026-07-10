"use client";

import { Button } from "@/components/ui/button";

interface RefreshControlProps {
  onRefresh: () => void;
}

export function RefreshControl({ onRefresh }: RefreshControlProps) {
  return (
    <div className="flex items-center">
      <Button variant="outline" size="sm" className="min-h-11" onClick={onRefresh}>
        Refresh now
      </Button>
    </div>
  );
}
