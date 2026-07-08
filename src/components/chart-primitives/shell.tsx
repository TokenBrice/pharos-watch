"use client";

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { cn } from "@/lib/utils";

interface ChartCardShellProps {
  embedded?: boolean;
  className?: string;
  header: ReactNode;
  body: ReactNode;
  legend?: ReactNode;
}

export function ChartCardShell({ embedded = false, className, header, body, legend }: ChartCardShellProps) {
  if (embedded) {
    return (
      <div className={cn("animate-in fade-in duration-300", className)}>
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">{header}</div>
        <div className="px-2 pb-4 pt-3 sm:px-4 sm:pb-6">{body}</div>
        {legend ? <div className="px-4 pb-4 sm:px-6 sm:pb-6">{legend}</div> : null}
      </div>
    );
  }

  return (
    <Card className={cn(DETAIL_MODULE_SHELL_CLASS, "animate-in fade-in duration-300", className)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>{header}</CardHeader>
      <CardContent className={DETAIL_MODULE_BODY_CLASS}>{body}</CardContent>
      {legend ? <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "pt-0")}>{legend}</CardContent> : null}
    </Card>
  );
}
