import { SOCIAL_CARD_FONTS, type SocialCardFace } from "@shared/lib/social-card/tokens";
import displayExtraBold from "../../assets/fonts/social-card/BricolageGrotesque-800.ttf";
import displaySemiBold from "../../assets/fonts/social-card/BricolageGrotesque-600.ttf";
import monoMedium from "../../assets/fonts/social-card/JetBrainsMono-500.ttf";
import monoBold from "../../assets/fonts/social-card/JetBrainsMono-700.ttf";

/** The four social-card faces a scorecard draws (it has no serif): the same bytes the Node renderer reads. */
const SCORECARD_FACES = {
  "display-800": displayExtraBold,
  "display-600": displaySemiBold,
  "mono-500": monoMedium,
  "mono-700": monoBold,
} as const satisfies Partial<Record<SocialCardFace, ArrayBuffer>>;

/** For HarfBuzz fitting. */
export const SCORECARD_FONT_BYTES: Partial<Record<SocialCardFace, Uint8Array>> = Object.fromEntries(
  Object.entries(SCORECARD_FACES).map(([face, data]) => [face, new Uint8Array(data)]),
);

/** For Satori, registered under the template's family names. */
export const OG_FONTS = (Object.keys(SCORECARD_FACES) as (keyof typeof SCORECARD_FACES)[]).map((face) => ({
  name: SOCIAL_CARD_FONTS[face].family,
  data: SCORECARD_FACES[face],
  weight: SOCIAL_CARD_FONTS[face].weight,
  style: SOCIAL_CARD_FONTS[face].style,
}));
