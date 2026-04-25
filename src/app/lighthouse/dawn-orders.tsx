"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { LighthouseActionLink } from "./story-model";

export function DawnOrders({ orders }: { orders: readonly LighthouseActionLink[] }) {
  return (
    <div className="lh-dawn-orders" data-testid="lighthouse-dawn-orders">
      {orders.map((order) => (
        <Link key={`${order.href}-${order.label}`} href={order.href} className="lh-dawn-order pharos-focus-ring">
          <span>
            <span className="text-sm font-semibold text-foreground">{order.label}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">{order.detail}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}
