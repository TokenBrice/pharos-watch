#!/usr/bin/env node
// Repository Node >=24.16 <27 with installed workspace tsx; run with node --import tsx.
// All peg-bucket amounts are already USD.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseStrictCliArgs, requireCliString, runDirectCli } from '../../../../scripts/lib/cli-args.mjs';
import { sumPegBucketsOrNull, getCirculatingRawOrNull, getPrevMonthRawOrNull } from '../../../../shared/lib/supply.ts';

const DAY = 86400;
const launched = Date.now();
const end = Math.floor(launched / 1000);
const start = end - 30 * DAY;
const startDay = Math.floor(start / DAY) * DAY;
const iso = (t) => new Date(t * 1000).toISOString();
const date = (t) => iso(t).slice(0, 10);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const numericId = (id) => /^\d+$/.test(String(id));
const absDelta = (a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd);
const pct = (now, before) => finite(now) && finite(before) && before > 0 ? (now / before - 1) * 100 : null;
const usd = (n) => !finite(n) ? 'unavailable' : `${n < 0 ? '−' : ''}$${(Math.abs(n) / (Math.abs(n) >= 1e9 ? 1e9 : 1e6)).toFixed(2)}${Math.abs(n) >= 1e9 ? 'B' : 'M'}`;
const percent = (n) => finite(n) ? `${n.toFixed(2)}%` : 'unavailable';
export function aggregatePulseSupply(coins, field) {
  const groups = new Map();
  for (const coin of coins) {
    if (numericId(coin.id)) continue;
    const key = coin[field] ?? 'unknown';
    const group = groups.get(key) ?? { currentUsd: null, previousUsd: null, comparableCurrentUsd: null, comparablePreviousUsd: null, totalCoins: 0, currentCoins: 0, previousCoins: 0, comparableCoins: 0, unavailableCurrent: 0, unavailableBaseline: 0 };
    const now = getCirculatingRawOrNull(coin); const before = getPrevMonthRawOrNull(coin);
    group.totalCoins++;
    if (now == null) group.unavailableCurrent++;
    else { group.currentUsd = (group.currentUsd ?? 0) + now; group.currentCoins++; }
    if (before == null) group.unavailableBaseline++;
    else { group.previousUsd = (group.previousUsd ?? 0) + before; group.previousCoins++; }
    if (now != null && before != null) {
      group.comparableCurrentUsd = (group.comparableCurrentUsd ?? 0) + now;
      group.comparablePreviousUsd = (group.comparablePreviousUsd ?? 0) + before;
      group.comparableCoins++;
    }
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].map(([key, group]) => {
    const coverage = (count) => count === 0 ? 'none' : count === group.totalCoins ? 'complete' : 'partial';
    return [key, { ...group, currentCoverage: coverage(group.currentCoins), previousCoverage: coverage(group.previousCoins), comparableCoverage: coverage(group.comparableCoins),
      deltaUsd: group.comparableCoins ? group.comparableCurrentUsd - group.comparablePreviousUsd : null,
      deltaPct: pct(group.comparableCurrentUsd, group.comparablePreviousUsd) }];
  }));
}
function required(condition, message) {
  if (!condition) throw new Error(`Missing required endpoint data: ${message}`);
}
function csv(columns, rows) {
  const cell = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))].join('\n') + '\n';
}
// Daily data use UTC calendar-day observations; never interpolate missing prices.
function atDay(rows, target) {
  return rows.filter((row) => row.date <= target).at(-1) ?? null;
}

async function main() {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { out: { type: 'string' } } });
  if (values.help) { console.log('Usage: node --import tsx .codex/skills/stablecoin-pulse-report/scripts/fetch-pulse-data.mjs --out <dir>'); return; }
  const out = resolve(requireCliString(values.out, '--out'));
  const data = join(out, 'data');
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  let apiKey = process.env.PHAROS_API_KEY?.trim();
  if (!apiKey) {
    let text = '';
    try { text = await readFile(join(repo, '.env.local'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const line = text.split(/\r?\n/).map((row) => row.trim().replace(/^export\s+/, '')).find((row) => row.startsWith('PHAROS_API_KEY='));
    let value = (line?.slice('PHAROS_API_KEY='.length) ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    else value = value.split('#')[0];
    apiKey = value.trim();
  }
  if (!apiKey) throw new Error('Authentication: PHAROS_API_KEY is missing from environment and repo-root .env.local');
  await mkdir(data, { recursive: true });
  const save = (name, value) => writeFile(join(data, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  const issues = [];
  let requestCount = 0;
  let lastRequest = 0;
  async function request(path, allow404 = false) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(Math.max(0, 510 - (Date.now() - lastRequest)));
      lastRequest = Date.now();
      requestCount++;
      const response = await fetch(`https://api.pharos.watch${path}`, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(60000) });
      if (response.status === 401 || response.status === 403) throw new Error(`Authentication failed (${response.status}) for ${path}; check PHAROS_API_KEY`);
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && Number.isFinite(Number(retry)) ? Number(retry) : null;
        const delay = seconds != null ? seconds * 1000 : Math.max(0, Date.parse(retry ?? '') - Date.now()) || 60000;
        issues.push(`${path}: HTTP 429; retry ${attempt + 1}, waiting ${delay}ms`);
        await response.body?.cancel();
        if (attempt < 5) { await sleep(delay); continue; }
      }
      if (response.status === 404 && allow404) { issues.push(`${path}: HTTP 404; unavailable`); return null; }
      if (!response.ok) throw new Error(`Required endpoint ${path} failed: HTTP ${response.status}`);
      const value = await response.json();
      required(value != null && !value.error, path);
      const warning = response.headers.get('warning');
      if (warning) issues.push(`${path}: ${warning}`);
      return value;
    }
  }
  const raw = {};
  for (const [name, path] of [
    ['stablecoins', '/api/stablecoins'], ['chains', '/api/chains'], ['digest-archive', '/api/digest-archive'],
    ['psi', '/api/stability-index?detail=true'], ['peg-summary', '/api/peg-summary'],
    ['mint-burn-flows', '/api/mint-burn-flows?hours=720'], ['blacklist-summary', '/api/blacklist-summary'],
    ['non-usd-share', '/api/non-usd-share?days=60'], ['charts', '/api/stablecoin-charts'],
  ]) {
    raw[name] = await request(path);
    await save(`${name}.json`, raw[name]);
  }
  // Retain every original page, as well as an API-shaped merged event envelope.
  let envelope;
  const events = new Map();
  for (const active of [false, true]) {
    let cursor;
    const cursors = new Set();
    let pageNumber = 0;
    do {
      const path = `/api/depeg-events?limit=1000&includePending=true${active ? '&active=true' : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await request(path);
      required(Array.isArray(page.events), path);
      await save(`depeg-events-${active ? 'active' : 'recent'}-page-${++pageNumber}.json`, page);
      envelope ??= page;
      for (const event of page.events) events.set(event.id, event);
      if (!active && page.events.some((event) => event.startedAt < start - 30 * DAY)) break;
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('depeg-events repeated a pagination cursor');
      cursors.add(cursor);
    } while (cursor);
  }
  await save('depeg-events.json', { ...envelope, events: [...events.values()] });
  const coins = raw.stablecoins.peggedAssets;
  required(Array.isArray(coins) && coins.length, 'stablecoins.peggedAssets');
  required(Array.isArray(raw.chains.chains) && raw.chains.chains.length, 'chains.chains');
  required(Array.isArray(raw['digest-archive'].digests) && raw['digest-archive'].digests.length, 'digest-archive.digests');
  required(Array.isArray(raw.psi.history) && raw.psi.history.length, 'psi.history');
  required(Array.isArray(raw['peg-summary'].coins) && finite(raw['peg-summary'].summary?.coinsAtPeg) && finite(raw['peg-summary'].summary?.totalTracked), 'peg-summary');
  required(Array.isArray(raw['non-usd-share']) && raw['non-usd-share'].length, 'non-usd-share');
  required(Array.isArray(raw.charts) && raw.charts.length, 'stablecoin-charts');
  required(Array.isArray(raw['mint-burn-flows'].coins) && raw['mint-burn-flows'].coins.length, 'mint-burn-flows.coins');
  required(raw['blacklist-summary'].stats && Object.keys(raw['blacklist-summary'].stats).length, 'blacklist-summary.stats');
  const coinMap = new Map(coins.map((coin) => [coin.id, coin]));
  const movers = [];
  const excluded = [];
  for (const coin of coins) {
    const now = getCirculatingRawOrNull(coin);
    const before = getPrevMonthRawOrNull(coin);
    const row = { id: coin.id, symbol: coin.symbol, pegType: coin.pegType, mechanism: coin.pegMechanism, supplyUsd_now: now, supplyUsd_30dAgo: before, deltaUsd: now != null && before != null ? now - before : null, deltaPct: pct(now, before) };
    const reasons = [numericId(coin.id) && 'numeric-id', now == null && 'absent-current', before == null && 'absent-baseline', before === 0 && 'zero-baseline'].filter(Boolean);
    if (reasons.length) excluded.push({ ...row, reason: reasons.join(';') }); else movers.push(row);
  }
  movers.sort(absDelta);
  const columns = ['id', 'symbol', 'pegType', 'mechanism', 'supplyUsd_now', 'supplyUsd_30dAgo', 'deltaUsd', 'deltaPct'];
  await save('movers-30d.csv', csv(columns, movers));
  await save('movers-excluded.csv', csv([...columns, 'reason'], excluded));
  const attribution = movers.slice(0, 25).map((row) => {
    const chains = []; const noBaseline = []; const unavailableCurrent = [];
    for (const [chain, value] of Object.entries(coinMap.get(row.id).chainCirculating ?? {})) {
      const now = sumPegBucketsOrNull({ current: value.current });
      const before = sumPegBucketsOrNull({ previous: value.circulatingPrevMonth });
      if (now == null) { unavailableCurrent.push(chain); continue; }
      if (before == null) noBaseline.push({ chain, currentUsd: now });
      else chains.push({ chain, currentUsd: now, previousUsd: before, deltaUsd: now - before });
    }
    return { id: row.id, symbol: row.symbol, deltaUsd: row.deltaUsd, chains: chains.sort(absDelta), noBaseline, unavailableCurrent };
  });
  await save('chain-attribution.json', attribution);
  // Chain API percentages are ratios; output percentages are percentage points.
  const chainRows = raw.chains.chains.map((chain) => ({ chain: chain.name, totalUsd: chain.totalUsd, change30dUsd: finite(chain.change30d) ? chain.change30d : null, change30dPct: finite(chain.change30dPct) ? chain.change30dPct * 100 : null, baseline: finite(chain.change30d) && finite(chain.change30dPct) ? 'ok' : 'none' }));
  await save('chains-30d.csv', csv(['chain', 'totalUsd', 'change30dUsd', 'change30dPct', 'baseline'], chainRows));

  const daily = new Map();
  for (const digest of raw['digest-archive'].digests) {
    if (digest.digestType !== 'daily' || !(digest.totalMcapUsd > 0) || !finite(digest.generatedAt) || digest.generatedAt > end) continue;
    const key = date(digest.generatedAt);
    if (!daily.has(key) || daily.get(key).generatedAt < digest.generatedAt) daily.set(key, { date: key, generatedAt: digest.generatedAt, totalMcapUsd: digest.totalMcapUsd });
  }
  const series = [...daily.values()].sort((a, b) => a.generatedAt - b.generatedAt);
  required(series.length > 1, 'positive daily digest totalMcapUsd series');
  const current = series.at(-1);
  const baselineFor = (day) => series.filter((row) => row.date <= day).at(-1) ?? null;
  const baseline30d = baselineFor(date(start));
  const baselineMtd = baselineFor(`${date(end).slice(0, 7)}-01`);
  const change = (baseline) => ({ baseline, deltaUsd: baseline ? current.totalMcapUsd - baseline.totalMcapUsd : null, deltaPct: baseline ? pct(current.totalMcapUsd, baseline.totalMcapUsd) : null });
  const peak = series.reduce((best, row) => row.totalMcapUsd > best.totalMcapUsd ? row : best);
  const psiHistory = raw.psi.history.filter((row) => row.date >= startDay && row.date <= end && finite(row.score)).sort((a, b) => a.date - b.date);
  required(psiHistory.length, 'PSI scores inside window');
  const nonUsd = [...raw['non-usd-share']].sort((a, b) => a.date - b.date);
  const market = {
    window: { start: iso(start), end: iso(end), dailyBaselineDay: date(start) },
    headlineSource: 'digest-archive.json: daily, positive totalMcapUsd, latest generatedAt per UTC day',
    dailySeries: series, current, change30d: change(baseline30d), monthToDate: change(baselineMtd),
    peak: { ...peak, drawdownPct: pct(current.totalMcapUsd, peak.totalMcapUsd) },
    shares: Object.fromEntries(['usdt-tether', 'usdc-circle'].map((id) => { const value = getCirculatingRawOrNull(coinMap.get(id)); return [id, { supplyUsd: value, sharePct: value == null ? null : value / current.totalMcapUsd * 100 }]; })),
    byPegType: aggregatePulseSupply(coins, 'pegType'), byPegMechanism: aggregatePulseSupply(coins, 'pegMechanism'),
    nonUsdShare: { start: atDay(nonUsd, startDay), end: atDay(nonUsd, end) },
    psi: { daily: psiHistory, start: psiHistory[0], end: psiHistory.at(-1), min: Math.min(...psiHistory.map((row) => row.score)), max: Math.max(...psiHistory.map((row) => row.score)), bandsSeen: [...new Set(psiHistory.map((row) => row.band))] },
    pegSummary: { coinsAtPeg: raw['peg-summary'].summary.coinsAtPeg, totalTracked: raw['peg-summary'].summary.totalTracked },
    blacklistWeekly: raw['blacklist-summary'].stats ? Object.fromEntries(Object.entries(raw['blacklist-summary'].stats).filter(([key]) => /7d|week/i.test(key))) : null,
  };
  await save('market.json', market);

  const units = [];
  for (const row of movers.slice(0, 40).filter((row) => row.pegType !== 'peggedUSD' || Math.abs((coinMap.get(row.id).price ?? 1) - 1) > 0.02)) {
    const history = await request(`/api/supply-history?stablecoin=${encodeURIComponent(row.id)}&days=45`, true);
    if (history == null) { units.push({ id: row.id, symbol: row.symbol, status: 'unavailable-404' }); continue; }
    required(Array.isArray(history), `supply-history ${row.id}`);
    await save(`supply-history-${row.id}.json`, history);
    const observations = [...history].filter((point) => finite(point.date)).sort((a, b) => a.date - b.date);
    const first = atDay(observations, startDay); const last = atDay(observations, end);
    const point = (value) => value && finite(value.price) && value.price > 0 && finite(value.circulatingUsd) ? { ...value, units: value.circulatingUsd / value.price } : null;
    const from = point(first); const to = point(last);
    if (!from || !to) { units.push({ id: row.id, symbol: row.symbol, status: 'missing-price-or-baseline', start: first, end: last }); continue; }
    units.push({ id: row.id, symbol: row.symbol, status: 'ok', start: from, end: to, deltaUsd: to.circulatingUsd - from.circulatingUsd, priceChangePct: pct(to.price, from.price), unitChangePct: pct(to.units, from.units), priceEffectUsd: from.units * (to.price - from.price), unitEffectUsd: (to.units - from.units) * to.price, method: 'price effect = starting units × price change; unit effect = unit change × ending price; sum equals history USD delta (not necessarily the live mover delta)' });
  }
  await save('unit-moves.json', units);
  const gainers = movers.filter((row) => row.deltaUsd > 0).sort((a, b) => b.deltaUsd - a.deltaUsd).slice(0, 10);
  const losers = movers.filter((row) => row.deltaUsd < 0).sort((a, b) => a.deltaUsd - b.deltaUsd).slice(0, 10);
  const largeMints = [];
  for (const row of [...gainers, ...losers]) {
    const minAmount = Math.max(25e6, 0.2 * Math.abs(row.deltaUsd));
    const path = `/api/mint-burn-events?stablecoin=${encodeURIComponent(row.id)}&minAmount=${minAmount}&limit=50`;
    const response = await request(path, true);
    if (response == null) {
      largeMints.push({ id: row.id, symbol: row.symbol, monthlyDeltaUsd: row.deltaUsd, minAmountUsd: minAmount, status: 'unavailable-404', events: [] });
      continue;
    }
    required(Array.isArray(response.events), path);
    await save(`mint-burn-events-${row.id}.json`, response);
    const inside = response.events.filter((event) => event.timestamp >= start && event.timestamp <= end).map((event) => ({ ...event, utcTime: iso(event.timestamp), monthlyDeltaSharePct: finite(event.amountUsd) ? event.amountUsd / Math.abs(row.deltaUsd) * 100 : null, flagged: finite(event.amountUsd) ? event.amountUsd >= 0.4 * Math.abs(row.deltaUsd) : null }));
    const truncated = Boolean(response.nextCursor) && (response.events.at(-1)?.timestamp ?? 0) >= start;
    if (truncated) issues.push(`${path}: 50-event cap reached inside window; not exhaustive`);
    largeMints.push({ id: row.id, symbol: row.symbol, monthlyDeltaUsd: row.deltaUsd, minAmountUsd: minAmount, truncated, events: inside });
  }
  await save('large-mints.json', largeMints);
  const pegMap = new Map(raw['peg-summary'].coins.map((coin) => [coin.id, coin]));
  const depegs = [...events.values()].filter((event) => event.startedAt <= end && (event.endedAt == null || event.endedAt >= start) && Math.abs(event.peakDeviationBps) >= 100).map((event) => ({ ...event, currentMcapUsd: getCirculatingRawOrNull(coinMap.get(event.stablecoinId)), currentPrice: coinMap.get(event.stablecoinId)?.price ?? null, currentDeviationBps: pegMap.get(event.stablecoinId)?.currentDeviationBps ?? null, pendingReason: event.pendingReason ?? null })).sort((a, b) => (b.currentMcapUsd ?? -1) - (a.currentMcapUsd ?? -1));
  await save('depegs.json', depegs);
  const digests = raw['digest-archive'].digests.filter((digest) => digest.generatedAt >= start && digest.generatedAt <= end).sort((a, b) => a.generatedAt - b.generatedAt);
  await save('digests.md', digests.map((digest) => `## ${date(digest.generatedAt)} [${digest.digestType}] ${digest.digestTitle ?? ''}\n\n${digest.digestExtended || digest.digestText || ''}\n`).join('\n'));

  const lines = [
    '# Pharos data brief — Stablecoin Pulse', '', `Window: ${iso(start)} → ${iso(end)} (30 days UTC). Source: Pharos API.`,
    'All supply figures are USD market cap unless noted. Δ30d uses circulatingPrevMonth. Percentages below are percentage points, not ratios.', '',
    '## Market-wide [market.json]',
    `- Headline: ${usd(current.totalMcapUsd)} (${current.date}); Δ30d ${usd(market.change30d.deltaUsd)} / ${percent(market.change30d.deltaPct)} from ${baseline30d?.date ?? 'unavailable'}. MTD ${usd(market.monthToDate.deltaUsd)} / ${percent(market.monthToDate.deltaPct)}.`,
    `- Full daily-series peak: ${usd(peak.totalMcapUsd)} on ${peak.date}; drawdown ${percent(market.peak.drawdownPct)}.`,
    ...Object.entries(market.shares).map(([id, value]) => `- ${id}: ${usd(value.supplyUsd)}, ${percent(value.sharePct)} of headline.`),
    ...Object.entries(market.byPegMechanism).map(([key, value]) => `- ${key}: ${usd(value.currentUsd)} now; current coverage ${value.currentCoins}/${value.totalCoins} (${value.currentCoverage}); baseline coverage ${value.previousCoins}/${value.totalCoins} (${value.previousCoverage}); comparable Δ30d ${usd(value.deltaUsd)} (${percent(value.deltaPct)}); comparable coverage ${value.comparableCoins}/${value.totalCoins} (${value.comparableCoverage}).`),
    `- PSI: ${market.psi.start.score} (${date(market.psi.start.date)}) → ${market.psi.end.score} (${date(market.psi.end.date)}); min/max ${market.psi.min}/${market.psi.max}; bands ${market.psi.bandsSeen.join(', ')}.`,
    `- At peg: ${market.pegSummary.coinsAtPeg}/${market.pegSummary.totalTracked}.`,
    `- Non-USD share: commodity ${percent(market.nonUsdShare.start?.commodityShare)} → ${percent(market.nonUsdShare.end?.commodityShare)}; fiat non-USD ${percent(market.nonUsdShare.start?.fiatNonUsdShare)} → ${percent(market.nonUsdShare.end?.fiatNonUsdShare)}.`,
    `- Available trailing-week blacklist stats (not monthly totals): ${JSON.stringify(market.blacklistWeekly)}.`, '',
    '## Biggest supply movers [movers-30d.csv; chain-attribution.json; unit-moves.json; large-mints.json]',
  ];
  for (const [label, rows] of [['Gainers', gainers], ['Losers', losers]]) {
    lines.push('', `### ${label}`);
    for (const row of rows) {
      const chain = attribution.find((entry) => entry.id === row.id);
      const unit = units.find((entry) => entry.id === row.id);
      lines.push(`- ${row.symbol} (${row.id}): ${usd(row.supplyUsd_30dAgo)} → ${usd(row.supplyUsd_now)}, Δ ${usd(row.deltaUsd)} (${percent(row.deltaPct)}).`);
      if (chain) {
        lines.push(`  - Chain attribution: ${chain.chains.slice(0, 5).map((entry) => `${entry.chain} ${usd(entry.deltaUsd)}`).join('; ') || 'no comparable observations'}.`);
        if (chain.noBaseline.length) lines.push(`  - No baseline: ${chain.noBaseline.map((entry) => `${entry.chain} ${usd(entry.currentUsd)} now`).join('; ')}.`);
      }
      if (unit?.status === 'ok') lines.push(`  - History ${date(unit.start.date)} → ${date(unit.end.date)}: units ${unit.start.units.toFixed(3)} → ${unit.end.units.toFixed(3)} (${percent(unit.unitChangePct)}); price ${unit.start.price.toFixed(4)} → ${unit.end.price.toFixed(4)} (${percent(unit.priceChangePct)}). USD split: price ${usd(unit.priceEffectUsd)}, units ${usd(unit.unitEffectUsd)}.`);
      else if (unit) lines.push(`  - Unit/price split unavailable: ${unit.status}.`);
      for (const event of largeMints.find((entry) => entry.id === row.id)?.events.filter((entry) => entry.flagged) ?? []) lines.push(`  - FLAGGED single ${event.direction}: ${event.amount} ${row.symbol} / ${usd(event.amountUsd)} (${percent(event.monthlyDeltaSharePct)} of |monthly delta|), ${event.utcTime}, ${event.chainId}, counterparty ${event.counterparty ?? 'unavailable'}, ${event.explorerTxUrl ?? event.txHash}.`);
    }
  }
  const comparableChains = chainRows.filter((row) => row.baseline === 'ok').sort((a, b) => b.change30dUsd - a.change30dUsd);
  lines.push('', '## Chain-level [chains-30d.csv]', 'Ranked by USD delta, not percentage growth.');
  for (const [label, rows] of [['Top 10', comparableChains.slice(0, 10)], ['Bottom 10', comparableChains.slice(-10).reverse()], ['No baseline ≥ $100M', chainRows.filter((row) => row.baseline === 'none' && row.totalUsd >= 1e8)]]) {
    lines.push('', `### ${label}`, ...rows.map((row) => `- ${row.chain}: ${usd(row.totalUsd)}; Δ30d ${usd(row.change30dUsd)} (${percent(row.change30dPct)}); baseline ${row.baseline}.`));
  }
  lines.push('', '## Depegs / stress [depegs.json]', ...depegs.map((event) => `- ${event.symbol} (${event.stablecoinId}): ${usd(event.currentMcapUsd)} now; peak ${event.peakDeviationBps} bps, current ${event.currentDeviationBps ?? 'unavailable'} bps / price ${event.currentPrice ?? 'unavailable'}; ${iso(event.startedAt)} → ${event.endedAt == null ? 'active' : iso(event.endedAt)}; pending: ${event.pendingReason ?? 'none'}.`));
  lines.push('', '## Data caveats',
    '- Headline, 30d/MTD changes, peak and drawdown use only the daily digest totalMcapUsd series, not chart totals or summed registry supply. Baselines use the last available UTC daily observation on/before the target day; dates are explicit in market.json.',
    '- Daily PSI, non-USD share and supply histories include the start UTC day. Event and digest-text filters use the exact rolling timestamps. Unit decomposition uses historical daily observations, not live circulatingPrevMonth; missing prices remain unavailable.',
    '- Mechanism/peg aggregates use non-numeric registry ids and canonical admitted supply; no observations means unavailable, not zero. Partial totals retain observed-member counts and coverage. Deltas compare only coins with both observations. Explicit zero baselines remain observed in aggregates but are excluded from ranked movers.',
    `- Excluded mover rows: ${excluded.length}; ids/reasons: ${excluded.map((row) => `${row.id} (${row.reason})`).join(', ')}. Full detail: movers-excluded.csv.`,
    `- Chain rows without a comparable baseline: ${chainRows.filter((row) => row.baseline === 'none').map((row) => row.chain).join(', ') || 'none'}. Never treat these as +100% growth. Per-coin unavailable chains are separate in chain-attribution.json.`,
    '- Chain attribution is raw and may not reconcile to global coin supply; no rescaling. Current coin prices come from stablecoins.json; deviations and peg counts come from peg-summary.json.',
    '- Recent depeg pages stop after crossing window-start minus 30 days; all active events are fetched separately. Older-started closed incidents may be outside this feed cut. Raw pages retain API metadata; merged depeg-events.json keeps the first response metadata (total is upstream, not collected count).',
    '- Mint/burn lookups cover top ten gainers and losers, capped at 50 events per coin above max($25M, 20% of |monthly delta|). Flags compare gross event USD with net monthly supply delta; they are not a causal attribution. Unknown USD valuation is never zero.',
    ...issues.map((issue) => `- Endpoint issue: ${issue}`), '', '## Digest research', 'Full window text: digests.md (daily and weekly entries, oldest first).', '');
  await save('brief.md', lines.join('\n'));
  const run = { generatedAt: iso(end), window: market.window, runtimeSeconds: (Date.now() - launched) / 1000, requestCount, issues, movers: movers.length, excluded: excluded.length, depegEventsCollected: events.size };
  await save('fetch-info.json', run);
  console.log(`Wrote ${data}\nBrief: ${join(data, 'brief.md')}\nHeadline ${usd(current.totalMcapUsd)}; 30d ${percent(market.change30d.deltaPct)}; PSI ${market.psi.end.score}; at peg ${market.pegSummary.coinsAtPeg}/${market.pegSummary.totalTracked}\n${requestCount} requests; ${run.runtimeSeconds.toFixed(1)}s; ${issues.length} endpoint advisories (fetch-info.json)`);
}
runDirectCli(import.meta.url, main, { label: 'fetch-pulse-data' });
