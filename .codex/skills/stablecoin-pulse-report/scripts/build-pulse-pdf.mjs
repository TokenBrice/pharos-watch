import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import {chromium} from 'playwright';
import {parseStrictCliArgs, requireCliString} from '../../../../scripts/lib/cli-args.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const {values} = parseStrictCliArgs(process.argv.slice(2), {options: {dir: {type: 'string'}}});
if (values.help) { console.log('Usage: node build-pulse-pdf.mjs --dir <report-directory>'); process.exit(0); }
const work = path.resolve(requireCliString(values.dir, '--dir'));
const dir = path.join(work, 'out');
const data = path.join(work, 'data');
const c = JSON.parse(await fs.readFile(path.join(work, 'content.json'), 'utf8'));
const fail = message => { throw new Error(`content.json: ${message}`); };
const text = (value, field) => { if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`); };
const array = (value, field) => { if (!Array.isArray(value) || !value.length) fail(`${field} must be a non-empty array`); };
const date = (value, field) => { text(value, field); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail(`${field} must be a valid YYYY-MM-DD date`); };
for (const field of ['title','subtitle','window','footer']) text(c[field], field);
date(c.period?.start, 'period.start'); date(c.period?.end, 'period.end');
if (c.period.start >= c.period.end) fail('period.start must precede period.end');
if (c.period.label !== undefined) text(c.period.label, 'period.label');
const monthLabel = new Intl.DateTimeFormat('en-US', {month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(c.period.end));
const reportLabel = c.period.label || monthLabel;
const fileLabel = /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(reportLabel) ? reportLabel : monthLabel;
const shortDate = value => { const parts=new Intl.DateTimeFormat('en-GB', {day:'2-digit',month:'short',timeZone:'UTC'}).formatToParts(new Date(value));return `${parts.find(p=>p.type==='day').value} ${parts.find(p=>p.type==='month').value.slice(0,3)}`; };
const range = `${shortDate(c.period.start)}${c.period.start.slice(0,4) !== c.period.end.slice(0,4) ? ' '+c.period.start.slice(0,4) : ''} – ${shortDate(c.period.end)} ${c.period.end.slice(0,4)}`;
const tone = (value, field) => { if (!['up','down','flat'].includes(value)) fail(`${field} must be up, down or flat`); };
array(c.kpis,'kpis');
c.kpis.forEach((k,i) => { for (const f of ['label','value','delta']) text(k[f],`kpis[${i}].${f}`); tone(k.tone,`kpis[${i}].tone`); });
for (const field of ['tldr','watch']) { array(c[field],field); c[field].forEach((s,i)=>text(s,`${field}[${i}]`)); }
array(c.sections,'sections');
const sections = Object.fromEntries(c.sections.map(s=>[s.id,s]));
for (const id of ['movers','launches','stress','market']) {
  const s=sections[id]; if (!s) fail(`missing section ${id}`); text(s.title,`sections.${id}.title`);
  if (id === 'movers') { array(s.rows,'sections.movers.rows'); s.rows.forEach((r,i)=>{ for(const f of ['asset','delta','pct','why']) text(r[f],`sections.movers.rows[${i}].${f}`); tone(r.tone,`sections.movers.rows[${i}].tone`); }); }
  else { array(s.items,`sections.${id}.items`); s.items.forEach((v,i)=>text(v,`sections.${id}.items[${i}]`)); }
}
text(c.annex?.title,'annex.title'); text(c.annex?.methodology,'annex.methodology'); array(c.annex?.blocks,'annex.blocks');
c.annex.blocks.forEach((b,i)=>{ for(const f of ['tag','heading','body']) text(b[f],`annex.blocks[${i}].${f}`); array(b.sources,`annex.blocks[${i}].sources`); b.sources.forEach((s,j)=>{text(s.label,`annex.blocks[${i}].sources[${j}].label`); let url; try { url=new URL(s.url); } catch { fail(`annex.blocks[${i}].sources[${j}].url must be an HTTPS URL`); } if(url.protocol!=='https:') fail(`annex.blocks[${i}].sources[${j}].url must be HTTPS`); }); });
if (!Array.isArray(c.chartAnnotations)) fail('chartAnnotations must be an array (empty is allowed)');
c.chartAnnotations.forEach((a,i)=>{date(a.date,`chartAnnotations[${i}].date`);text(a.label,`chartAnnotations[${i}].label`);if(a.date<c.period.start||a.date>c.period.end)fail(`chartAnnotations[${i}].date falls outside period`);});
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const archive=JSON.parse(await fs.readFile(path.join(data,'digest-archive.json'),'utf8'));
const days=new Map();
for(const d of archive.digests){
  if(d.digestType!=='daily'||!(d.totalMcapUsd>0))continue;
  const stamp=typeof d.generatedAt==='number'?d.generatedAt*1000:Date.parse(d.generatedAt);
  if(!Number.isFinite(stamp))continue;
  const day=new Date(stamp).toISOString().slice(0,10);
  if(day<c.period.start||day>c.period.end)continue;
  if(!days.has(day)||stamp>days.get(day).stamp)days.set(day,{day,stamp,value:d.totalMcapUsd/1e9});
}
const points=[...days.values()].sort((a,b)=>a.day.localeCompare(b.day));
if(points.length<2)throw new Error('Market chart needs at least two daily data points within period');
function lineChart(){
  const min=Math.floor(Math.min(...points.map(d=>d.value))*2)/2;
  const max=Math.ceil(Math.max(...points.map(d=>d.value))*2)/2;
  const x=day=>40+(Date.parse(day)-Date.parse(c.period.start))/(Date.parse(c.period.end)-Date.parse(c.period.start))*296;
  const lanes=[];
  const annotations=c.chartAnnotations.map(a=>{const width=a.label.length*5.3; if(width>296)fail('chartAnnotation label is too long for the chart');const left=Math.max(40,Math.min(336-width,x(a.date)-width/2));let lane=lanes.findIndex(end=>end+8<left);if(lane<0){lane=lanes.length;lanes.push(0);}lanes[lane]=left+width;return {...a,left,lane};});
  const top=22+lanes.length*12, bottom=top+58;
  const y=value=>bottom-(value-min)/(max-min||1)*58;
  return `<svg viewBox="0 0 350 ${bottom+24}" role="img" aria-label="Daily stablecoin market capitalization in USD billions"><g font-family="Arial" font-size="10" fill="#596575">${[min,(min+max)/2,max].map(v=>`<path d="M40 ${y(v)}H338" stroke="#dddcd5"/><text x="1" y="${y(v)+3}">${v.toFixed(1)}</text>`).join('')}${annotations.map(a=>`<path d="M${x(a.date)} ${14+a.lane*12}V${bottom}" stroke="#9aa7aa" stroke-width=".5"/><text x="${a.left}" y="${11+a.lane*12}" fill="#263d52">${esc(a.label)}</text>`).join('')}<polyline points="${points.map(d=>`${x(d.day)},${y(d.value)}`).join(' ')}" fill="none" stroke="#273d52" stroke-width="2"/>${[points[0],points.at(-1)].map((d,i)=>`<circle cx="${x(d.day)}" cy="${y(d.value)}" r="2.5" fill="#273d52"/><text x="${x(d.day)}" y="${y(d.value)-7}" text-anchor="${i?'end':'start'}" fill="#263d52" stroke="#fbfaf6" stroke-width="3" paint-order="stroke">$${d.value.toFixed(1)}B</text>`).join('')}<text x="40" y="${bottom+18}">${esc(shortDate(c.period.start))}</text><text x="336" y="${bottom+18}" text-anchor="end">${esc(shortDate(c.period.end))}</text></g></svg>`;
}
// RFC 4180: preserve quoted commas and escaped quotes.
function csv(input){let rows=[],row=[],field='',quoted=false;for(let i=0;i<input.length;i++){const ch=input[i];if(ch==='"'){if(quoted&&input[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){row.push(field);field='';}else if(ch==='\n'&&!quoted){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=ch;}if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}const keys=rows.shift();if(!keys||!['id','symbol','supplyUsd_30dAgo','deltaUsd'].every(k=>keys.includes(k)))throw new Error('movers-30d.csv is missing required columns');return rows.filter(r=>r.length===keys.length).map(r=>Object.fromEntries(keys.map((k,i)=>[k,r[i]])));}
const movers=csv(await fs.readFile(path.join(data,'movers-30d.csv'),'utf8')).filter(r=>!/^\d+$/.test(r.id)&&Number(r.supplyUsd_30dAgo)>0&&r.deltaUsd.trim()!==''&&Number.isFinite(Number(r.deltaUsd))).map(r=>({id:r.id,name:r.symbol,value:Number(r.deltaUsd)}));
const chains=JSON.parse(await fs.readFile(path.join(data,'chains.json'),'utf8')).chains;
if(!Array.isArray(chains))throw new Error('chains.json must contain chains[]');
const chainMovers=chains.filter(r=>Number.isFinite(r.change30d)).map(r=>({id:r.id,name:r.name,value:r.change30d}));
const rank=rows=>({gain:rows.filter(r=>r.value>0).sort((a,b)=>b.value-a.value).slice(0,6),loss:rows.filter(r=>r.value<0).sort((a,b)=>a.value-b.value).slice(0,6)});
const coinRank=rank(movers),chainRank=rank(chainMovers);
const money=value=>`$${(Math.abs(value)/(Math.abs(value)>=1e9?1e9:1e6)).toFixed(Math.abs(value)>=1e9?2:0)}${Math.abs(value)>=1e9?'B':'M'}`;
const noBaseline=chains.filter(r=>r.change30d==null&&r.totalUsd>=1e8).map(r=>`${r.name} ${money(r.totalUsd)}`).join('; ');
function barChart(){
  return `<svg viewBox="0 0 725 84" role="img" aria-label="Ranked coin gainers, coin losers, chain gainers and chain losers; shared scale within coins and within chains"><g font-family="Arial" font-size="10">${[
    {rank:coinRank,side:'gain',title:'Coins ▲'}, {rank:coinRank,side:'loss',title:'Coins ▼'},
    {rank:chainRank,side:'gain',title:'Chains ▲'}, {rank:chainRank,side:'loss',title:'Chains ▼'},
  ].map(({rank,side,title},panel)=>{
    const max=Math.max(1,...rank.gain.map(d=>d.value),...rank.loss.map(d=>-d.value));
    const color=side==='gain'?'#27765a':'#af453d';
    return `<g transform="translate(${panel*181.25},0)"><text x="0" y="9" font-weight="bold" fill="${color}">${title}</text>${rank[side].map((d,i)=>{
      const y=12+i*12;
      return `<text x="0" y="${y+9}" fill="#263443">${esc(d.name)}</text><rect x="84" y="${y+2}" width="${Math.abs(d.value)/max*36}" height="7.2" fill="${color}" opacity=".8"/><text x="125" y="${y+9}" fill="${color}">${side==='gain'?'+':'−'}${money(d.value)}</text>`;
    }).join('')}</g>`;
  }).join('')}</g></svg>`;
}
const sourceType=url=>{const host=new URL(url).hostname.replace(/^www\./,'');if(['x.com','twitter.com'].includes(host))return 'X';if(/(^|\.)(etherscan\.io|solscan\.io|tronscan\.org|basescan\.org|arbiscan\.io)$/.test(host))return 'On-chain';return 'Web';};
const logo=await fs.readFile(path.join(root,'public/pharos-mark-on-light.svg'),'utf8');
const list=items=>`<ul>${items.map(x=>`<li>${x}</li>`).join('')}</ul>`;
const smallSection=(id,n)=>`<section class="compact"><h2><span>${n}</span>${esc(sections[id].title)}</h2>${list(sections[id].items)}</section>`;
const footer=n=>`<footer><span>${esc(c.footer)} · Data: Pharos (<a href="https://pharos.watch">pharos.watch</a>)</span><span>Pharos · ${n}</span></footer>`;
const css=`
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;color:#202e3a;background:#e3e5e7;font-family:Arial,Helvetica,sans-serif;font-size:8pt;line-height:1.3}
a{color:inherit;text-decoration:underline;text-decoration-thickness:.5px;text-underline-offset:2px}
b{font-weight:700}
.page{width:210mm;height:296mm;padding:8mm 9mm;background:#fbfaf6;position:relative;display:flex;flex-direction:column;break-after:page;break-inside:avoid}
.page:last-child{break-after:auto}
.page-body{flex:1;min-height:0}
header{border-top:4px solid #263d52;border-bottom:1px solid #263d52;padding:5px 0 6px;margin-bottom:7px}
.eyebrow{font-size:7.5pt;letter-spacing:1px;text-transform:uppercase;color:#596575;display:flex;justify-content:space-between;align-items:center}
.brand{display:flex;align-items:center;gap:6px;letter-spacing:1px}
.brand svg{width:20px;height:20px}
.brand::after{content:'PHAROS'}.brand>span{margin-right:8px}
h1{font-family:Georgia,serif;font-weight:normal;font-size:23pt;line-height:1.1;letter-spacing:-.8px;margin:5px 0}
.subtitle{font-size:9pt;color:#526171;margin:0}
.window{font-size:7.5pt;margin-top:5px;color:#596575}
.kpis{display:grid;grid-template-columns:repeat(var(--count),1fr);gap:0;margin-bottom:8px;border-bottom:1px solid #c8ccc9;padding-bottom:7px}
.kpi{padding:0 7px;border-right:1px solid #d6d8d3}
.kpi:first-child{padding-left:0}
.kpi:last-child{border:0}
.label{font-size:7.5pt;color:#596575}
.value{font-family:Georgia,serif;font-size:18pt;line-height:1.2;margin:3px 0;white-space:nowrap}
.delta{font-size:7.5pt}
.up{color:#27765a}.down{color:#af453d}.flat{color:#596575}
.lede{display:grid;grid-template-columns:1.12fr 1fr;gap:12px;border-bottom:1px solid #c8ccc9;padding-bottom:6px;margin-bottom:6px}
h2{font-size:10pt;font-family:Georgia,serif;margin:0 0 6px;line-height:1.15}
h2 span{font-family:Arial;font-size:7.5pt;color:#7b858b;margin-right:7px}
ul{padding:0;margin:0;list-style:none}
li{padding:0 0 5px 9px;position:relative}
li:before{content:'•';position:absolute;left:0;color:#78868f}
.chart-title{font-size:7.5pt;font-weight:bold;margin:0 0 3px}
.chart-note{font-size:7.5pt;color:#687581}
.line svg,.bars svg{width:100%;display:block}
.movers{margin-bottom:8px}
table{border-collapse:collapse;width:100%;font-size:7.5pt}
th{text-align:left;font-weight:normal;color:#596575;font-size:7.5pt;border-bottom:1px solid #aeb8bd;padding:3px 0}
td{vertical-align:top;padding:1px 0;line-height:1.2;border-bottom:1px solid #e2e2da}
th:first-child,td:first-child{width:9%;font-weight:bold}
th:nth-child(2),td:nth-child(2){width:12%;padding-right:8px;white-space:nowrap}
td:last-child{width:79%}
.bars{margin-top:7px}
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:6px 0}
.compact{border-top:2px solid #263d52;padding-top:7px}
.compact h2{font-size:9.5pt;white-space:nowrap}
.compact li{padding-bottom:4px}
.watch{background:#edf0eb;border-left:3px solid #263d52;padding:6px 8px;margin-top:6px}
.watch h2{margin-bottom:5px}
.watch ul{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}
.watch li{padding-bottom:0}
footer{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #a9b0b0;padding-top:7px;margin-top:8px;font-size:7.5pt;color:#64707a;flex-shrink:0}
.annex-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px 20px;align-items:start;margin-top:10px}
.annex-block{break-inside:avoid;border-top:2px solid #263d52;padding-top:6px}
.annex-block h2{font-size:11pt;text-wrap:balance}
.annex-block .body{font-size:7.5pt;line-height:1.28}
.sources{font-size:7.5pt;margin-top:5px;color:#64707a;line-height:1.3}
.sources a{display:block;overflow-wrap:anywhere}
.method{border-top:1px solid #c8ccc9;margin-top:12px;padding-top:8px;font-size:7.5pt;color:#526171;line-height:1.4}
.method h2{color:#263d52}
#page-1{font-size:7.5pt;line-height:1.25}
.usd{font-size:8pt;white-space:nowrap}.pct{display:block;font-size:7.5pt;color:#64707a;padding-left:8px}.direction{font-size:7.5pt;margin-right:2px}body{font-variant-numeric:tabular-nums}h1,h2{break-after:avoid;orphans:2;widows:2;text-wrap:balance}.watch{border-left-color:#27765a;padding:8px;margin-top:8px}.watch h2{font-weight:700;color:#263d52;margin-bottom:8px}.tag{font-size:7.5pt;text-transform:uppercase;letter-spacing:1px;color:#27765a;margin-bottom:4px}.annex-grid{display:flex;gap:20px}.annex-column{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}.source-type{font-variant:small-caps;font-weight:bold}.baseline{white-space:nowrap}.bars{margin-top:8px}.three{gap:16px;margin:8px 0}.compact{padding-top:8px}.method{margin-top:8px}.annex-block{padding-top:8px}
.page{padding-top:7mm;padding-bottom:7mm}.lede{gap:16px}.compact li{padding-bottom:3px}
.bars .chart-title{margin-bottom:0;line-height:10px}.bars .baseline{line-height:10px}
@media screen{.page{margin:20px auto;box-shadow:0 2px 15px #0002}}
@media print{html,body{background:#fbfaf6}.page{margin:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(c.title)}</title><style>${css}</style></head><body><article class="page" id="page-1"><div class="page-body"><header><div class="eyebrow"><span>PHAROS × POLARIS · MONTHLY STABLECOIN PULSE</span><span class="brand"><span>${esc(range).toUpperCase()}</span>${logo}</span></div><h1>${esc(c.title)}</h1><p class="subtitle">${esc(c.subtitle)}</p><div class="window">${esc(c.window)}</div></header><div class="kpis" style="--count:${c.kpis.length}">${c.kpis.map(k=>`<div class="kpi"><div class="label">${esc(k.label)}</div><div class="value">${esc(k.value)}</div><div class="delta ${esc(k.tone)}">${esc(k.delta)}</div></div>`).join('')}</div><div class="lede"><section><h2>The month in brief</h2>${list(c.tldr)}</section><figure class="line" style="margin:0"><figcaption class="chart-title">Market capitalization</figcaption>${lineChart()}<div class="chart-note">Daily market cap · USD billions · axis not zero-based</div></figure></div><section class="movers"><h2><span>01</span>${esc(sections.movers.title)}</h2><table><thead><tr><th>Asset</th><th>Δ 30d</th><th>Where the change came from</th></tr></thead><tbody>${sections.movers.rows.map(r=>`<tr><td>${esc(r.asset)}</td><td class="${esc(r.tone)}"><span class="usd"><span class="direction">${r.tone==="up"?"▴":r.tone==="down"?"▾":"·"}</span>${esc(r.delta)}</span><span class="pct">${esc(r.pct)}</span></td><td>${r.why}</td></tr>`).join('')}</tbody></table><figure class="bars" style="margin-left:0;margin-right:0;margin-bottom:0"><figcaption class="chart-title">Where the dollars moved · Δ 30d</figcaption>${barChart()}${noBaseline?`<div class="chart-note baseline">no 30d baseline: ${esc(noBaseline)}</div>`:""}</figure></section><div class="three">${smallSection('launches','02')}${smallSection('stress','03')}${smallSection('market','04')}</div><aside class="watch"><h2>What to watch</h2>${list(c.watch)}</aside></div>${footer(1)}</article><article class="page" id="page-2"><div class="page-body"><header><div class="eyebrow"><span>PHAROS × POLARIS · EVIDENCE & CONTEXT</span><span>${esc(reportLabel).toUpperCase()}</span></div><h1>${esc(c.annex.title)}</h1><p class="subtitle">Source notes, attribution limits and the signals behind the headline.</p></header><div class="annex-grid">${c.annex.blocks.map((b,i)=>`<section class="annex-block"><div class="tag">${esc(b.tag)}</div><h2><span>${String(i+1).padStart(2,'0')}</span>${esc(b.heading)}</h2><div class="body">${b.body}</div><div class="sources">${b.sources.map(s=>`<a href="${esc(s.url)}"><span class="source-type">${sourceType(s.url)}</span> · ${esc(s.label)}</a>`).join('')}</div></section>`).join('')}</div><section class="method"><h2>Methodology & reading notes</h2>${c.annex.methodology}</section></div>${footer(2)}</article></body></html>`;
await fs.mkdir(dir,{recursive:true});
await fs.writeFile(path.join(dir,'report.html'),html);
let browser,browserPath;
try { browser=await chromium.launch({headless:true}); browserPath='Playwright bundled Chromium'; }
catch (bundledError) { try { browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})}); browserPath=process.env.CHROME_PATH?'CHROME_PATH: '+process.env.CHROME_PATH:'installed Google Chrome (channel chrome)'; } catch (chromeError) { throw new Error('No usable Chromium browser. Install with npx playwright install chromium, install Google Chrome, or set CHROME_PATH. '+bundledError.message+'; '+chromeError.message); } }
try {
  const page=await browser.newPage({viewport:{width:1000,height:1300},deviceScaleFactor:140/96});
  await page.goto(pathToFileURL(path.join(dir,'report.html')).href);
  await page.emulateMedia({media:'print'});
  await page.evaluate(()=>document.fonts.ready);
  // Balance actual measured block heights, keeping each evidence block intact.
  await page.evaluate(()=>{const grid=document.querySelector('.annex-grid'),blocks=[...grid.children];const columns=[document.createElement('div'),document.createElement('div')];columns.forEach(e=>{e.className='annex-column';grid.append(e);});for(const block of blocks){const target=columns[0].getBoundingClientRect().height<=columns[1].getBoundingClientRect().height?columns[0]:columns[1];target.append(block);}});
  const layout=await page.evaluate(()=>[...document.querySelectorAll('.page')].map(p=>{const body=p.querySelector('.page-body'),footer=p.querySelector('footer'),f=footer.getBoundingClientRect(),bounds=p.getBoundingClientRect();const elements=[...body.querySelectorAll('*')].filter(e=>!(e instanceof SVGElement));const end=Math.max(...elements.map(e=>e.getBoundingClientRect().bottom));const small=elements.filter(e=>[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(e).fontSize)<10);const horizontal=elements.some(e=>{const r=e.getBoundingClientRect();return r.left<bounds.left-.5||r.right>bounds.right+.5||e.scrollWidth>e.clientWidth+1;});return {page:p.id,contentBottom:end-bounds.top,footerTop:f.top-bounds.top,clearancePx:f.top-end,clearanceMm:(f.top-end)*25.4/96,overflow:Math.max(0,end-f.top),horizontal,undersizedText:small.map(e=>e.className)};}));
  if(layout.some(p=>p.overflow>0||p.horizontal||p.undersizedText.length))throw new Error('Content exceeds page budget: '+JSON.stringify(layout));
  // Save the balanced DOM so report.html exactly matches the exported PDF.
  await fs.writeFile(path.join(dir,'report.html'),'<!doctype html>'+await page.content());
  const pdfPath=path.join(dir,'report.pdf');
  await page.pdf({path:pdfPath,format:'A4',printBackground:true,preferCSSPageSize:true});
  let pages,pageCountPath;
  try {const info=execFileSync('pdfinfo',[pdfPath],{encoding:'utf8',stdio:['ignore','pipe','pipe']});pages=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);const size=info.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);if(!size||Math.abs(Number(size[1])-595.28)>1||Math.abs(Number(size[2])-841.89)>1)throw new Error('PDF is not A4: '+info);pageCountPath='pdfinfo';}
  catch(error){if(error.code!=='ENOENT')throw error;const bytes=await fs.readFile(pdfPath);let objects=bytes.toString('latin1');for(const match of objects.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)){if(/\/Type\s*\/ObjStm/.test(match[1])){if(!/\/FlateDecode/.test(match[1]))throw new Error('Unsupported PDF object stream');objects+='\n'+inflateSync(Buffer.from(match[2],'latin1')).toString('latin1');}}pages=[...objects.matchAll(/\/Type\s*\/Page\b/g)].length;const boxes=[...objects.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)];if(!boxes.length||boxes.some(m=>Math.abs(Number(m[1])-595.28)>1||Math.abs(Number(m[2])-841.89)>1))throw new Error('PDF MediaBox is not A4');pageCountPath='PDF page-object / MediaBox inspection';}
  if(pages!==2)throw new Error('PDF must have exactly 2 pages; got '+pages);
  let pngPath;
  try {execFileSync('pdftoppm',['-png','-r','140',pdfPath,path.join(dir,'page')],{stdio:['ignore','pipe','pipe']});pngPath='pdftoppm (actual PDF, 140 dpi)';}
  catch(error){if(error.code!=='ENOENT')throw error;for(let i=1;i<=2;i++){await page.locator('#page-'+i).screenshot({path:path.join(dir,'page-'+i+'.png')});}pngPath='Playwright printed-page screenshots (HTML preview, 140 dpi; not PDF rasterization)';}
  const namedCopy=path.join(work,'Stablecoin-Pulse-'+fileLabel.replace(' ','-')+'.pdf');
  await fs.copyFile(pdfPath,namedCopy);
  const info={dailyPoints:points.length,first:points[0],last:points.at(-1),coins:coinRank,chains:chainRank,noBaseline,pages,browserPath,pageCountPath,pngPath,layout};
  await fs.writeFile(path.join(dir,'build-info.json'),JSON.stringify(info,null,2)+'\n');
  console.log('Built '+pdfPath+' (2 A4 pages); '+points.length+' daily points.');
  console.log('Browser: '+browserPath+'; page count: '+pageCountPath+'; PNG: '+pngPath);
  for(const p of layout)console.log(p.page+': footer clearance '+p.clearancePx.toFixed(2)+' CSS px ('+p.clearanceMm.toFixed(2)+' mm); no overflow; body text ≥ 7.5pt.');
  console.log('Final copy: '+namedCopy);
} finally {await browser.close();}
