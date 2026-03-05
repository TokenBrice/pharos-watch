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

  const secondsLeft = Math.max(0, 60 - elapsedSeconds);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{"\u27F3"} {secondsLeft}s</span>
      <Button variant="outline" size="sm" onClick={onRefresh}>
        Refresh
      </Button>
    </div>
  );
}
