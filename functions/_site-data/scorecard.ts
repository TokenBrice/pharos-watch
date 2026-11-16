import { withNoindex } from "../lib/noindex";
import { createSocialScorecard, type SocialScorecardEnv } from "../lib/social-scorecard";

export const onRequest = async ({ request, env }: { request: Request; env: SocialScorecardEnv }): Promise<Response> =>
  withNoindex(await createSocialScorecard(request, env));
