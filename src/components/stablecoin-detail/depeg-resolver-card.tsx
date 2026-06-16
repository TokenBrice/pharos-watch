"use client";

import { StablecoinDepegResolverRows } from "@/components/depeg-resolver-row-card-parts";
import { useDepegResolver } from "@/hooks/api-hooks";
import { isDepegResolverEnabled } from "@/lib/feature-flags";

interface StablecoinDepegResolverCardProps {
  stablecoinId: string;
  logoSrc?: string;
}

export function StablecoinDepegResolverCard({ stablecoinId, logoSrc }: StablecoinDepegResolverCardProps) {
  const enabled = isDepegResolverEnabled();
  const resolver = useDepegResolver({ enabled });

  return <StablecoinDepegResolverRows stablecoinId={stablecoinId} data={resolver.data} logoSrc={logoSrc} />;
}
