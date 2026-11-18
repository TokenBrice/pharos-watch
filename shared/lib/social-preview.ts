/** Canonical dimensions and route-map entry for evergreen and authored social previews. */
export const SOCIAL_PREVIEW_WIDTH = 1200;
export const SOCIAL_PREVIEW_HEIGHT = 630;

export interface SocialPreviewImage {
  title: string;
  description: string;
  url: string;
  alt: string;
  width: typeof SOCIAL_PREVIEW_WIDTH;
  height: typeof SOCIAL_PREVIEW_HEIGHT;
  type: "image/png";
}
