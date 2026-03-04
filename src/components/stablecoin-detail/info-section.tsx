"use client";

import { KeyInfoCard } from "@/components/key-info-card";
import type { StablecoinMeta } from "@/lib/types";

interface InfoSectionProps {
  coin: StablecoinMeta;
}

export function InfoSection({ coin }: InfoSectionProps) {
  return (
    <section id="info" className="space-y-6">
      <KeyInfoCard meta={coin} />
    </section>
  );
}
