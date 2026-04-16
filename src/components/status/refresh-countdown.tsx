"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface RefreshCountdownProps {
  onRefresh: () => void;
}

export function RefreshCountdown({ onRefresh }: RefreshCountdownProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsedSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Updated {elapsedSeconds}s ago</span>
      <Button variant="outline" size="sm" onClick={onRefresh}>
        Refresh now
      </Button>
    </div>
  );
}
