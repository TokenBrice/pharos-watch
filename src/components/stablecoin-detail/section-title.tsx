"use client";

import { cn } from "@/lib/utils";
import { CardTitle } from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "./section-title-class";

export function DetailSectionTitle({
  children,
  as = "h2",
  className,
  id,
}: {
  children: React.ReactNode;
  as?: "h1" | "h2" | "h3" | "h4" | "div";
  className?: string;
  id?: string;
}) {
  return (
    <CardTitle as={as} className={cn(DETAIL_SECTION_TITLE_CLASS, className)} id={id}>
      {children}
    </CardTitle>
  );
}
