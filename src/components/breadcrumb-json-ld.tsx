import { safeJsonLd } from "@/lib/json-ld";

export function BreadcrumbJsonLd({ name, path }: { name: string; path: string }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJsonLd({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://pharos.watch" },
            { "@type": "ListItem", position: 2, name, item: `https://pharos.watch${path}` },
          ],
        }),
      }}
    />
  );
}
