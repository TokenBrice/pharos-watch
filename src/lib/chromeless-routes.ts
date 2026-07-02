export function isChromelessPath(pathname: string | null): boolean {
  return pathname === "/pharoswatchbot/app" || pathname?.startsWith("/pharoswatchbot/app/") === true;
}
