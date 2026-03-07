"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
import { useUsdsStatus } from "@/hooks/use-usds-status";

function formatLastChecked(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function UsdsLogo({ active, className }: { active: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <circle cx="25" cy="25" r="25" fill="url(#usds-grad)" />
      <path
        d="M15.3975 31.5312H11.8398C12.1303 37.0855 16.777 41.9138 25.0178 41.9138C33.2222 41.9138 38.4498 37.4122 38.4498 31.6038C38.4498 27.4653 35.4367 22.9274 28.2487 20.4588C23.5657 18.8615 21.7868 16.8285 21.7868 14.7956C21.7868 12.9078 23.3115 10.9112 26.4336 10.9112C29.9187 10.9112 33.8394 13.6339 34.1298 17.1189H37.6512C37.2881 11.492 31.8064 7.57129 24.8363 7.57129C17.612 7.57129 12.1666 11.7824 12.1666 17.7361C12.1666 22.1287 15.0708 26.1947 22.0409 28.6269C26.8329 30.188 28.8296 32.1483 28.8296 34.6169C28.8296 36.7951 27.2686 38.6102 23.8924 38.6102C19.6813 38.6102 15.6516 35.6697 15.3975 31.5312ZM26.5062 23.4719C33.7305 25.9042 34.8922 29.5345 34.8922 31.7853C34.8922 34.5443 33.077 36.9766 30.8988 37.5938C31.6612 36.8677 32.242 35.2704 32.242 33.7456C32.242 31.1318 30.4995 27.9735 24.0376 25.7227C16.5955 23.1815 15.6879 19.6964 15.6879 17.6272C15.6879 14.6866 17.5757 12.327 19.9354 11.6009C19.0278 12.6537 18.3744 14.1784 18.3744 15.6305C18.3744 18.3169 20.5888 21.5116 26.5062 23.4719Z"
        fill="white"
      />
      <defs>
        <radialGradient
          id="usds-grad"
          cx="0" cy="0" r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(25.0417 57.9537) rotate(-90) scale(80.1336)"
        >
          {active ? (
            <>
              <stop stopColor="#ff4444" />
              <stop offset="1" stopColor="#991b1b" />
            </>
          ) : (
            <>
              <stop stopColor="#FFD232" />
              <stop offset="1" stopColor="#FF6D6D" />
            </>
          )}
        </radialGradient>
      </defs>
    </svg>
  );
}

export function UsdsStatusCard() {
  const { data: status, isLoading } = useUsdsStatus();

  if (isLoading) {
    return (
      <Card className="rounded-xl border-l-[3px] border-l-violet-500">
        <CardHeader className="pb-1">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-6 w-20" />
        </CardContent>
      </Card>
    );
  }

  if (!status) return null;

  return (
    <MetricStatCard
      borderColorClass="border-l-violet-500"
      title="USDS Blacklist Status"
      headerRight={
        status.freezeActive ? (
          <Badge variant="destructive" className="text-xs">Active</Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">Not Active</Badge>
        )
      }
    >
      <div className="flex flex-col items-center text-center gap-2 sm:flex-row sm:text-left sm:gap-4">
        <UsdsLogo
          active={status.freezeActive}
          className={`size-10 sm:size-12 shrink-0 ${status.freezeActive ? "" : "opacity-60 saturate-50"}`}
        />
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Sky (ex-MakerDAO) can enable blacklist-related features via a governance vote
          </p>
          <p className="text-xs text-muted-foreground">
            Last checked: {formatLastChecked(status.lastChecked)}
          </p>
        </div>
      </div>
    </MetricStatCard>
  );
}
