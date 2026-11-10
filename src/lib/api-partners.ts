export interface ApiPartner {
  name: string;
  /** Square brand mark under public/partners/, rendered in a circle. */
  logoSrc: string;
  href: string;
}

// Teams that build on the Pharos API and agreed to be named. Alphabetical, so
// the order never reads as a ranking. Add a team only with its consent. Shared
// by /api/ and the homepage API strip; both render native images, so this
// module stays free of client code.
export const API_PARTNERS: readonly ApiPartner[] = [
  { name: "CurveDEX", logoSrc: "/partners/curvedex.webp", href: "https://llama.box/curvedex/" },
  { name: "Frankencoin", logoSrc: "/partners/frankencoin.webp", href: "https://www.frankencoin.com/" },
  { name: "KPK", logoSrc: "/partners/kpk.webp", href: "https://kpk.io/" },
  { name: "Newton", logoSrc: "/partners/newton.webp", href: "https://newton.xyz/" },
];
