"use client";

import { DigestNameplate } from "@/components/digest-nameplate";
import { useDigestLead } from "@/hooks/use-digest-lead";
import type { DigestContentEntry } from "@shared/types";

/**
 * Masthead edition picked by the same rule as the archive lead, so the issue
 * number and date always describe the edition rendered below it.
 */
export function DigestNameplateLive({ initialLead }: { initialLead?: DigestContentEntry }) {
  const { editionNumber, editionDate } = useDigestLead(initialLead);
  return <DigestNameplate issueNumber={editionNumber ?? undefined} date={editionDate ?? undefined} />;
}
