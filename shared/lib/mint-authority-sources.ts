import type { MintAuthorityProfile, StablecoinLink } from "../types";

/** Authored profile evidence, preserving occurrences and order for audit counts. */
export function collectMintAuthoritySources(profile: MintAuthorityProfile): StablecoinLink[] {
  const links: StablecoinLink[] = [];
  const append = (sources: readonly StablecoinLink[] | undefined) => {
    if (Array.isArray(sources)) links.push(...sources);
  };
  append(profile.review?.sources);
  append(profile.review?.noLocalIssuance?.sources);
  for (const question of Array.isArray(profile.review?.scopedQuestions) ? profile.review.scopedQuestions : []) append(question?.sources);
  for (const incident of Array.isArray(profile.mintIncidents) ? profile.mintIncidents : []) append(incident?.sources);
  append(profile.upgradeability?.sources);
  append(profile.governedIssuance?.sources);
  append(profile.capSemanticsReview?.sources);
  for (const control of Array.isArray(profile.controls) ? profile.controls : []) {
    append(control?.sources);
    append(control?.keyCustodyAttestation?.sources);
  }
  return links;
}
