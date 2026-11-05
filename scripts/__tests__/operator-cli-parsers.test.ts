import {join} from "node:path"
import fs from "node:fs"
import cp from "node:child_process"
import {syncBuiltinESMExports as sync} from "node:module"
import {afterEach,expect as e,it,vi} from "vitest"
import {withTempRepo} from "./helpers/test-state"
import pkg from "../../package.json"

const launch=vi.hoisted(()=>vi.fn())
vi.mock("playwright",()=>({chromium:{launch}}))
import {parseFreezeStablecoinArgs as freeze} from "../maintenance/freeze-stablecoin"
import {parseD1InsightsArgs as d1} from "../maintenance/capture-d1-insights.mjs"
import {parseSeoRenderBudgetArgs as seo,runSeoRenderBudget as runSeo} from "../maintenance/audit-seo-render-budget.mjs"
import {parseAgentLandArgs as land,runAgentLand as runLand} from "../maintenance/agent-land"
import {parseAgentWorktreeArgs as worktree,runAgentWorktree as runTree} from "../maintenance/agent-worktree"
import {run as wait} from "../maintenance/wait-pages-release-marker.ts"

const args=(line:string)=>line?line.split(" "):[]
const lane="--lane /lane --target /target --review /review.json --message-file /message",boot="--path lane --base HEAD"
const invalid=(line:string,flag:string,other:string)=>["",flag,...args(line).flatMap((_,i,av)=>i%2?[]:[[...av.slice(0,i),...av.slice(i+2)].join(" ")]),
...["--unknown","extra",`${flag} ${other}`].map(extra=>`${line} ${extra}`)]
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();sync();})

it.each([runLand,runTree].flatMap(run=>["-h","--help"].map(flag=>[run,flag] as const)))("runner help %s %s",(run,flag)=>{
const out=vi.fn(),spies=[vi.spyOn(cp,"spawnSync"),...([
"exists","lstat","readdir","readFile","readlink","realpath",
"close","mkdir","mkdtemp","open","write",
] as const).map(name=>vi.spyOn(fs,`${name}Sync`))]
for(const spy of spies) spy.mockImplementation(()=>{throw Error("Unexpected I/O");})
sync();e(run([flag],{log:out,output:out})).toBeUndefined()
e(out).toHaveBeenCalledWith(e.stringMatching(/^(Usage: )?agent:(land|worktree) /))
for(const spy of spies) e(spy).not.toHaveBeenCalled()
})
it.each([
["land","scripts/maintenance/agent-land.ts"],["worktree","scripts/maintenance/agent-worktree.ts"],
] as const)("agent command %s",(name,path)=>e(pkg.scripts[`agent:${name}`]).toBe(`node --import tsx ${path}`))

it.each([
[land,lane,{lane:"/lane",target:"/target",review:"/review.json",messageFile:"/message",apply:false,help:false}],
[worktree,boot,{path:"lane",base:"HEAD",apply:false,help:false}],
[seo,"",{waitMs:4000,json:false,help:false,apiFailureReplay:false}],
[seo,"--routes=/,/api/ --wait-ms=0 --json",{routes:["/","/api/"],waitMs:0,json:true}],
[seo,"--url=https://x.test --api-failure-replay",{baseUrl:"https://x.test",apiFailureReplay:true}],
...[seo,land,worktree].flatMap(parse=>["-h","--help"].map(flag=>[parse,flag,{help:true}] as const)),
[d1,"",{database:"stablecoin-db",config:"worker/wrangler.toml",limit:50,periods:[],sortBy:[],output:null,dryRun:false}],
[d1,"--period=7d --period 30d --sort-by=reads --sort-by time --dry-run",{periods:["7d","30d"],sortBy:["reads","time"],dryRun:true}],
] as const)("accepts %s %s",(parse,av,want)=>e(parse(args(av))).toMatchObject(want))
it.each([
[seo,["--unknown","--url","--wait-ms=invalid","--wait-ms=-1","--url=one --url=two","extra","--routes=,","--api-failure-replay --api-failure-replay"]],
[land,invalid(lane,"--lane","/other")],[worktree,invalid(boot,"--path","other")],
[d1,["--unknown","--database","--limit=2x","--limit=0","--database=one --database=two","extra",
..."database config limit period sort-by output".split(" ").flatMap(f=>[`--${f} --dry-run`,`--${f}=--dry-run`])]],
])("rejects %s usage",(parse,rows)=>{
for(const av of rows) e(()=>parse(args(av))).toThrow(e.objectContaining({exitCode:2}))
})
it("freeze targets",()=>{
e(freeze(args("--dry-run usdc-circle"))).toEqual({coinId:"usdc-circle",dryRun:true,help:false})
for(const av of ["","one two"]) e(()=>freeze(args(av))).toThrow("exactly one <coinId>")
e(()=>freeze(args("--coin usdc-circle"))).toThrow("Unknown option")
})
it("SEO help avoids browser launch",async()=>{
const log=vi.spyOn(console,"log").mockImplementation(()=>{})
launch.mockReset();await e(runSeo(["--help"])).resolves.toBeUndefined()
for(const text of ["--api-failure-replay","Replay selected profile, Alt-Pegs and seed-pilot routes with API reads returning an injected 503."])
e(log).toHaveBeenCalledWith(e.stringContaining(text))
e(launch).not.toHaveBeenCalled()
})
const executablePath="/browser"
it.each([
[undefined,undefined,{}],[" /browser ",undefined,{executablePath}],
[undefined," chrome-beta ",{channel:"chrome-beta"}],[" /browser "," chrome-beta ",{executablePath}],
])("SEO launch %s %s",async(exe,channel,want)=>{
for(const [name,value] of Object.entries({SEO_AUDIT_BROWSER_EXECUTABLE_PATH:exe,SEO_AUDIT_BROWSER_CHANNEL:channel,
GITHUB_ACTIONS:"true",SMOKE_UI_BROWSER_CHANNEL:"chrome",SMOKE_UI_BROWSER_EXECUTABLE_PATH:"/other"})) vi.stubEnv(name,value)
const err=Error();launch.mockReset().mockRejectedValue(err)
await e(runSeo(args("--routes=/ --wait-ms=0"))).rejects.toBe(err)
e(launch).toHaveBeenCalledExactlyOnceWith({headless:true,...want})
})
it("cache-busted marker retry",()=>withTempRepo("release-marker",{"m.json":'{"commit":"target"}'},async dir=>{
const commits=["old","target"],fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{
e(new URL(String(input)).searchParams.get("expected")).toBe("target");return Response.json({commit:commits.shift()})
})
await wait(["--url","https://one.test/m.json","--marker",join(dir,"m.json"),"--attempts","2","--delay-ms","0"])
e(fetch).toHaveBeenCalledTimes(2)
}))
