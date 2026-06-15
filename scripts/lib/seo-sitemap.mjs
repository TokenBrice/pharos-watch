export function parseSitemapLocs(xml, { asSet = false } = {}) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let match = re.exec(xml);
  while (match) {
    locs.push(match[1]);
    match = re.exec(xml);
  }
  return asSet ? new Set(locs) : locs;
}
