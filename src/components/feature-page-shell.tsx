import Link from "next/link";
import { BreadcrumbJsonLd, type BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { cn } from "@/lib/utils";

export interface FeaturePageShellProps {
  breadcrumbName: string;
  path: string;
  breadcrumbItems?: BreadcrumbItem[];
  title: string;
  variant?: "standard" | "longform" | "auth-gated";
  containerClassName?: string;
  methodology?: {
    version: string;
    changelogPath: string;
  };
  headerActions?: React.ReactNode;
  leadParagraphs?: readonly React.ReactNode[];
  headerSupplement?: React.ReactNode;
  preface?: React.ReactNode;
  children: React.ReactNode;
}

export function FeaturePageShell({
  breadcrumbName,
  path,
  breadcrumbItems,
  title,
  variant = "standard",
  containerClassName,
  methodology,
  headerActions,
  leadParagraphs = [],
  headerSupplement,
  preface,
  children,
}: FeaturePageShellProps) {
  const variantClassName =
    variant === "longform"
      ? "mx-auto w-full max-w-3xl space-y-6"
      : variant === "auth-gated"
        ? "mx-auto w-full max-w-5xl space-y-6"
        : "space-y-6";

  return (
    <div className={cn(variantClassName, containerClassName)}>
      <BreadcrumbJsonLd
        items={
          breadcrumbItems ?? [
            { name: "Home", url: "/" },
            { name: breadcrumbName, url: path },
          ]
        }
      />
      {preface}
      <div className="space-y-2.5">
        <div className="flex max-w-full flex-wrap items-start justify-between gap-x-3 gap-y-3">
          <div className="flex min-w-0 max-w-4xl flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="pharos-page-title">{title}</h1>
          </div>
          {headerActions}
        </div>
        {methodology && (
          <p className="pharos-meta">
            Methodology {methodology.version}.{" "}
            <Link
              href={methodology.changelogPath}
              className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
            >
              Version history &rarr;
            </Link>
          </p>
        )}
        {leadParagraphs.length > 0 ? (
          <div className="max-w-4xl space-y-2">
            {leadParagraphs.map((paragraph, index) => (
              <p key={index} className={index === 0 ? "pharos-page-lead" : "pharos-lead"}>
                {paragraph}
              </p>
            ))}
          </div>
        ) : null}
        {headerSupplement}
      </div>
      {children}
    </div>
  );
}
