import { formatPharosUrn, type PharosUrnEntityClass } from "@shared/lib/citation/urn";

export interface PharosUrnJsonLdIdentifier {
  "@type": "PropertyValue";
  propertyID: "Pharos URN";
  value: string;
}

export function buildPharosUrnJsonLdIdentifier(
  entityClass: PharosUrnEntityClass,
  id: string,
  qualifier?: string,
): PharosUrnJsonLdIdentifier {
  return {
    "@type": "PropertyValue",
    propertyID: "Pharos URN",
    value: formatPharosUrn(entityClass, id, qualifier),
  };
}
