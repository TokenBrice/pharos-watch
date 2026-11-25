"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PublicDocRelatedRoute } from "@shared/lib/public-docs";

export interface DocsDirectoryEntry {
  slug: string;
  title: string;
  summary: string;
  clusterId: string;
  updatedDate: string | null;
  dateModified: string | null;
  relatedRoute?: PublicDocRelatedRoute;
}

export interface DocsDirectoryCluster {
  id: string;
  title: string;
  description: string;
  docs: readonly DocsDirectoryEntry[];
}

interface DocsDirectoryProps {
  clusters: readonly DocsDirectoryCluster[];
  totalCount: number;
}

export function DocsDirectory({ clusters, totalCount }: DocsDirectoryProps) {
  const [selectedClusterId, setSelectedClusterId] = useState<string>("all");
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();

  const visibleClusters = useMemo(() => {
    return clusters
      .filter((cluster) => selectedClusterId === "all" || cluster.id === selectedClusterId)
      .map((cluster) => {
        if (!normalizedQuery) return cluster;
        const matched = cluster.docs.filter((doc) => {
          const haystack = [doc.title, doc.summary, doc.slug, doc.relatedRoute?.label ?? ""]
            .join(" ")
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        });
        return { ...cluster, docs: matched };
      })
      .filter((cluster) => cluster.docs.length > 0);
  }, [clusters, normalizedQuery, selectedClusterId]);

  const visibleCount = visibleClusters.reduce((sum, cluster) => sum + cluster.docs.length, 0);
  const hasActiveFilter = selectedClusterId !== "all" || normalizedQuery.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 border-b border-border/60 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Filter documentation by topic" className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={selectedClusterId === "all"}
            onClick={() => setSelectedClusterId("all")}
            className="pharos-control-pill pharos-focus-ring"
          >
            All (<span className="pharos-numeric">{totalCount}</span>)
          </button>
          {clusters.map((cluster) => (
            <button
              key={cluster.id}
              type="button"
              aria-pressed={selectedClusterId === cluster.id}
              onClick={() => setSelectedClusterId(cluster.id)}
              className="pharos-control-pill pharos-focus-ring"
            >
              {cluster.title} (<span className="pharos-numeric">{cluster.docs.length}</span>)
            </button>
          ))}
        </div>

        <div className="relative w-full shrink-0 sm:w-64">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter specs..."
            aria-label="Filter technical specifications"
            className="pharos-focus-ring min-h-9 w-full rounded-md border border-border/70 bg-background/75 py-1.5 pr-8 pl-9 text-sm text-foreground placeholder:text-muted-foreground"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
              className="pharos-focus-ring absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={hasActiveFilter ? "text-xs text-muted-foreground" : "sr-only"}
      >
        Showing <span className="pharos-numeric font-medium text-foreground">{visibleCount}</span> of{" "}
        <span className="pharos-numeric">{totalCount}</span> technical specifications.
      </p>

      {visibleClusters.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-muted/20 px-5 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No technical specs match that filter.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try another keyword or clear the topic filter to browse all{" "}
            <span className="pharos-numeric">{totalCount}</span> specifications.
          </p>
          <button
            type="button"
            onClick={() => {
              setSelectedClusterId("all");
              setQuery("");
            }}
            className="pharos-control-pill pharos-focus-ring mt-4"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <div className="space-y-10">
          {visibleClusters.map((cluster) => (
            <section key={cluster.id} aria-labelledby={`docs-cluster-${cluster.id}`} className="space-y-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2
                    id={`docs-cluster-${cluster.id}`}
                    className="pharos-display text-2xl font-bold tracking-tight text-foreground"
                  >
                    {cluster.title}
                  </h2>
                  <span className="pharos-numeric text-xs text-muted-foreground">
                    {cluster.docs.length} {cluster.docs.length === 1 ? "spec" : "specs"}
                  </span>
                </div>
                <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{cluster.description}</p>
              </div>

              <ul className="divide-y divide-border/50 border-t border-border/60">
                {cluster.docs.map((doc) => (
                  <li key={doc.slug} className="py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <Link
                        href={`/docs/${doc.slug}/`}
                        className="pharos-focus-ring rounded-sm text-base font-semibold text-foreground transition-colors hover:text-brand-accent-text"
                      >
                        {doc.title}
                      </Link>
                      {doc.updatedDate && doc.dateModified ? (
                        <span className="text-xs text-muted-foreground">
                          Updated{" "}
                          <time dateTime={doc.dateModified} className="pharos-numeric text-foreground/85">
                            {doc.updatedDate}
                          </time>
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">{doc.summary}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                      {doc.relatedRoute ? (
                        <Link
                          href={doc.relatedRoute.href}
                          className={cn(
                            "pharos-focus-ring inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5 font-medium text-foreground/85 transition-colors hover:border-foreground/20 hover:text-foreground",
                          )}
                        >
                          <span>{doc.relatedRoute.label}</span>
                          <ArrowUpRight aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
                        </Link>
                      ) : null}
                      <a
                        href={`/docs/${doc.slug}/index.md`}
                        aria-label={`Plain Markdown for ${doc.title}`}
                        className="pharos-focus-ring rounded-sm font-mono text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                      >
                        .md
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
