import Link from "next/link";
import type { CoverageFeatureDefinition } from "@/lib/coverage";

export interface CoverageFeatureLinkProps {
  feature: CoverageFeatureDefinition;
  className?: string;
  children: React.ReactNode;
}

export function CoverageFeatureLink({
  feature,
  className,
  children,
}: CoverageFeatureLinkProps) {
  if (!feature.href) {
    return <span className={className}>{children}</span>;
  }

  if (feature.external) {
    return (
      <a
        href={feature.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={feature.href} className={className}>
      {children}
    </Link>
  );
}
