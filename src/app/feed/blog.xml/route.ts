// Next.js does not inherit route segment config from a re-export; these must be re-declared.
export const dynamic = "force-static";
export const revalidate = false;

export { GET } from "../blog/route";
