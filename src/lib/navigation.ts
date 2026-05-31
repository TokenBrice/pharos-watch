export function isRouteActive(pathname: string, href: string): boolean {
  const normalizedPathname = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
  const normalizedHref = href === "/" ? "/" : href.replace(/\/+$/, "");
  if (normalizedHref === "/") return normalizedPathname === "/";
  return normalizedPathname === normalizedHref || normalizedPathname.startsWith(`${normalizedHref}/`);
}
