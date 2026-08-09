import type { MechanismArchetype } from "@shared/types";
import { safeJsonLd } from "@/lib/json-ld";
import {
  buildArchetypeArticleJsonLd,
  buildDefinedTermSetJsonLd,
} from "@/lib/page-metadata";

/**
 * `<script type="application/ld+json">` component for the mechanism hub
 * page. Emits the `DefinedTermSet` document covering every tracked archetype.
 */
export function MechanismJsonLd() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJsonLd(buildDefinedTermSetJsonLd()),
      }}
    />
  );
}

/**
 * `<script type="application/ld+json">` component for the per-archetype
 * explainer page. Emits the `Article` document.
 */
export function ArchetypeArticleJsonLd({
  archetype,
}: {
  archetype: MechanismArchetype;
}) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJsonLd(buildArchetypeArticleJsonLd(archetype)),
      }}
    />
  );
}
