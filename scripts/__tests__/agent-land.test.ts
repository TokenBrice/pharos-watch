import{execFileSync,spawnSync} from "node:child_process"
import{chmodSync,mkdirSync,readFileSync as r,readlinkSync,renameSync,rmSync,symlinkSync,writeFileSync as put} from "node:fs"
import{join as j,resolve} from "node:path"
import{afterEach,expect as e,it,vi} from "vitest"
import{buildLandingPlan as plan,parseAgentLandArgs as parse,runAgentLand as run} from "../maintenance/agent-land"
import{withTempRepo} from "./helpers/test-state"

vi.mock("node:child_process",async load=>{
const cp=await load<typeof import("node:child_process")>()
return{...cp,spawnSync:vi.fn(cp.spawnSync)}
})
const child=vi.mocked(spawnSync),real=child.getMockImplementation()!
afterEach(()=>{child.mockImplementation(real);})
const base="a\nb\nc\nd\ne\nf\n",lane=base.replace("a","l"),late="safety-score-v9-evaluation-build"
const cache="tsconfig.typecheck.tsbuildinfo",focused="focused checks",node=process.execPath
const empty:ReturnType<typeof plan>["review"]["artifacts"]={
ids:[],checkIds:[],outputs:[],generate:[],check:[],pending:[],validatorOutputs:["v"],
}
function repo(run:(f:ReturnType<typeof setup>)=>void,ids:string[]=[]){
return withTempRepo("land",{"t/a":base,"t/v":"same","t/del":"old","t/module/index.ts":"old","t/.gitignore":"node_modules\ni\nv\n.cache/\n*.tsbuildinfo\n",msg:"x\n",
"t/scripts/ci/select-generated-artifacts.mts":`export const selectChangedGeneratedArtifactIds=p=>p.join()==='a'?${JSON.stringify(ids)}:[];`,
"t/scripts/lib/automation-registry.mjs":`export const selectGeneratedArtifacts=({only})=>{if(!only.length)throw Error('all');return (only.includes('leaf')?['dep',...only]:only).map(id=>({id,bootstrap:id!=='live',checkable:id!=='dep',outputPaths:[id+'.out']}))};`,
"t/scripts/maintenance/run-generated-artifacts.ts":"export const buildGeneratedArtifactExecutionPhases=o=>[o];",
},r=>run(setup(r)))
}
function setup(root:string){
const t=j(root,"t"),l=j(root,"l"),msg=j(root,"msg")
const git=(cwd:string,...args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null",...args],
{cwd,encoding:"utf8",env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}})
git(t,"init","-q")
for(const [k,v] of [["user.name","F"],["user.email","f@x"],["commit.gpgSign","false"]]) git(t,"config",k,v)
const commit=(c=t)=>{git(c,"add",".");git(c,"commit","-qm","f");}
commit()
git(t,"worktree","add","--detach",l,"HEAD")
symlinkSync(resolve("node_modules"),j(t,"node_modules"))
const av=["--lane",l,"--target",t,"--review",j(root,"review"),"--message-file",msg]
const w=(name:string,text:string|Buffer,cwd=l)=>put(j(cwd,name),text)
const rt={planArtifacts:()=>empty,runCommand:vi.fn(),log:vi.fn()}
const save=()=>{const p=plan(parse(av),rt);put(av[5],JSON.stringify(p.review));return p.review.paths;}
const apply=()=>run([...av,"--apply"],rt)
const index=(cwd:string)=>git(cwd,"rev-parse","--path-format=absolute","--git-path","index").trim()
w("a",lane)
const sha=(c=t)=>git(c,"rev-parse","HEAD")
const snap=()=>[av[1],av[3]].map(c=>[sha(c),r(index(c)),git(c,"diff","--binary","HEAD"),
git(c,"ls-files","-o","--exclude-standard","-z").split("\0").filter(Boolean).map(p=>[p,r(j(c,p))])])
return{t,l,msg,git,av,w,rt,save,apply,index,sha,commit,snap}
}
it.each([false,true,"i","fd","df","fl",cache,"cold","worker"])("land %s",g=>repo(f=>{
const o=g==="i"?"i" :"out"
if(g) f.rt.planArtifacts=()=>({...empty,ids:["f"],outputs:[o]})
f.rt.runCommand.mockImplementation(c=>{
if(c.stage==="generation") f.w(o,"ok",f.t)
if(c.stage!==focused) return
if(g===cache) f.w(cache,"x",f.t)
if(g==="cold"){f.w("tmp",r(j(f.t,"v")),f.t);renameSync(j(f.t,"tmp"),j(f.t,"v"));}
if(g==="worker") for(const role of ["public","heavy"]){const p=j(f.t,`.cache/release-check/worker-bundle-${role}`);mkdirSync(p,{recursive:true});put(j(p,"a"),"x");}
})
f.w("a",base.replace("f","t"),f.t);f.commit()
f.w(":(glob)*",Buffer.from([0,255]));f.w("exe","old");chmodSync(j(f.l,"exe"),0o755)
symlinkSync("/outside/missing",j(f.l,"link"));rmSync(j(f.l,"del"))
symlinkSync(f.t,j(f.l,"d l"))
if(g==="fl") symlinkSync("a",j(f.l,"del"))
if(g==="fd"){mkdirSync(j(f.l,"del"));f.w("del/index.ts","n");}
if(g==="df"){rmSync(j(f.l,"module"),{recursive:true});f.w("module","n");}
const index=f.index(f.l),old=r(index)
run(f.av,f.rt);e(r(index)).toEqual(old);e(f.rt.runCommand).not.toHaveBeenCalled()
const ps=f.save();f.apply()
e(f.rt.runCommand).toHaveBeenCalledWith({stage:focused,executable:"npm",cwd:f.t,args:["run","check:focused","--",
...[...ps,...(g?[o] :[])].sort().flatMap(p=>["--file",p])]})
e(r(j(f.t,"a"),"utf8")).toBe(lane.replace("f","t"))
e(f.git(f.t,"status","--porcelain")).toBe("")
e(f.git(f.t,"ls-tree","HEAD")).toMatch(/100755.*exe[\s\S]*120000.*link/)
e(r(j(f.t,":(glob)*"))).toEqual(Buffer.from([0,255]))
e(readlinkSync(j(f.t,"d l"))).toBe(f.t)
if(g==="fl") e(readlinkSync(j(f.t,"del"))).toBe("a")
if(g==="fd") e(r(j(f.t,"del/index.ts"),"utf8")).toBe("n")
if(g==="df") e(r(j(f.t,"module"),"utf8")).toBe("n")
}))
it.each(["content","path","mode","message","head","branch","detach","index","lane-index","same","other","ahead","empty","dirty","untracked",
...["MERGE_HEAD","CHERRY_PICK_HEAD","rebase-merge","rebase-apply"].flatMap(m=>["l:"+m,"t:"+m])])("reject %s",k=>repo(f=>{
f.save()
if(k==="content"||k==="path") f.w(k==="content"?"a" :"extra","n")
if(k==="mode") chmodSync(j(f.l,"a"),0o755)
if(k==="message") put(f.msg,"y\n")
if(k==="head") f.git(f.t,"commit","--allow-empty","-qm","moved")
if(k==="branch"||k==="detach") f.git(f.t,"checkout",...(k==="branch"?["-qb","other"]:["--detach"]))
if(k.endsWith("index")){
const cwd=k==="index"?f.t :f.l
f.w("a","s",cwd);f.git(cwd,"add","a");f.w("a",cwd===f.t?base :lane,cwd)
}
if(k==="same") f.av[3]=f.l
if(k==="other"){const p=j(f.t,"..","o");f.git(f.t,"clone","-q",f.t,p);f.av[3]=p;}
if(k==="ahead"){f.commit(f.l);f.w("a","n");}
if(k==="empty") f.w("a",base)
if(k==="dirty"||k==="untracked") f.w(k==="dirty"?"a" :"u","x",f.t)
if(k.includes(":")){const [x,m]=k.split(":"),p=j(f.index(x==="l"?f.l :f.t),"..",m);if(m.startsWith("rebase")) mkdirSync(p);else put(p,f.sha());}
const old=f.snap(),why=k.endsWith("index")?"git diff" :k==="same"||k==="other"?"Require distinct" :k==="ahead"?"git merge-base"
:k==="empty"?"Empty lane" :k.includes(":")?"In-progress" :k==="dirty"||k==="untracked"?"Target must be clean" :"Review"
e(f.apply).toThrow(why);e(f.rt.runCommand).not.toHaveBeenCalled();e(f.snap()).toEqual(old)
}))
it("conflict",()=>repo(f=>{
f.w("a","t\n",f.t);f.commit()
f.save();e(f.apply).toThrow(/cherry-pick/)
e(f.git(f.t,"show",":2:a")).toBe("t\n")
e(f.git(f.t,"show",":3:a")).toBe(lane)
}))
it.each<string[]>([[],[late],["leaf",late],["live"]])("plan %j",(...ids)=>repo(f=>{
const build=()=>plan(parse(f.av))
if(ids.includes("live")) e(build).toThrow(/Not offline bootstrap-safe: live/)
else{
const full=ids.includes("leaf"),only=full?["dep","leaf"] :[],check=full?["leaf"] :[]
const p=build(),runner=["--import","tsx","scripts/maintenance/run-generated-artifacts.ts"]
const cmd=(stage:string,executable:string,args:string[])=>({stage,executable,args,cwd:f.t})
e(p.review.artifacts).toEqual({ids:only,checkIds:check,outputs:only.map(id=>`${id}.out`),
generate:full?[{bootstrap:true,only}] :[],check:full?[{check:true,integrityOnly:true,only:check}] :[],pending:[late],validatorOutputs:["stablecoin-client-registry.out"]})
e(p.commands).toEqual([
...(full?[cmd("generation",node,[...runner,"--bootstrap","--only=dep,leaf"]),
cmd("artifact checks",node,[...runner,"--check","--integrity-only","--only=leaf"])] :[]),
cmd(focused,"npm",["run","check:focused","--","--file","a"]),cmd("unused code","npm",["run","check:unused-code"]),
])
}
},ids))
it.each([
["generation",node,0,7,null],["artifact checks",node,1,7,null],
[focused,"npm",0,7,null],["unused code","npm",1,7,null],
[focused,"npm",0,0,"SIGTERM"],[focused,"npm",0,0,null],["git diff","git",0,1,null],
] as const)("child %s/%s/%s/%s/%s",(stage,cmd,skip,status,signal)=>repo(f=>{
if(cmd===node) f.rt.planArtifacts=()=>({...empty,ids:["f"],checkIds:["f"]})
if(cmd==="git") f.w("extra","n")
f.save();const sha=f.sha()
child.mockImplementation((exe,args,opts)=>exe==="git"&&!(cmd==="git"&&args?.includes("--no-index"))?real(exe,args,opts)
:{pid:0,output:[],stdout:Buffer.alloc(0),stderr:Buffer.from("x"),status:skip-- > 0?0 :status,
signal,error:status===0&&!signal?Error() :undefined})
e(()=>run([...f.av,"--apply"],{planArtifacts:f.rt.planArtifacts,log:f.rt.log}))
.toThrow(`${stage}: ${cmd} failed (status ${status}, signal ${signal ?? "none"})`)
e(f.sha()).toBe(sha)
}))
it.each(["head","branch","detach","gen-branch","gen-source","gen-mode","gen-delete","index","source","outputs","message","review","output","plan","ignored-write","ignored-validator","v"])("retains %s",k=>repo(f=>{
let n=0;const gen=k.startsWith("gen-"),scope=gen||k==="output"||k==="plan"||k==="ignored-write"
f.rt.planArtifacts=()=>({...empty,ids:["f"],outputs:gen?[]:[k==="plan"&&n++ > 2?"other" :k.startsWith("ignored")?"out" :"i"]})
const path=k==="index"?f.index(f.t) :k==="message"?f.msg :k==="review"?f.av[5] :j(f.t,k==="v"?"v" :k==="outputs"||k==="ignored-validator"?"i" :"a")
const state=()=>k==="head"?f.sha() :r(path)
let kept:ReturnType<typeof state>
f.rt.runCommand.mockImplementation(c=>{
if(c.stage==="generation"){
if(k==="gen-branch") f.git(f.t,"checkout","-qb","other")
else if(k==="gen-mode") chmodSync(path,0o755)
else if(k==="gen-delete") rmSync(path)
else f.w(gen?"a":k==="output"?"rogue" :k==="ignored-write"?cache :k==="ignored-validator"?"out" :"i","ok",f.t)
}
if(c.stage !== focused||scope) return
if(k==="head") f.commit()
else if(k==="branch"||k==="detach") f.git(f.t,"checkout",...(k==="branch"?["-qb","other"]:["--detach"]))
else if(k==="index") f.git(f.t,"update-index","--chmod=+x","a")
else put(path,k==="review"?"{}" :"mutated")
kept=state()
})
if(k==="ignored-write") f.w(cache,"old",f.t)
f.save();const sha=f.sha()
e(f.apply).toThrow(k==="gen-branch"?"Target identity before staging":gen?"Reviewed source after generation":k==="plan"?"Combined artifact ownership" :k==="output"||k==="ignored-write"?"Undeclared output write" :k==="v"?"Validator artifact content" :undefined)
if(scope) e(f.rt.runCommand).toHaveBeenCalledTimes(k==="plan"?0 :1)
if(kept! !== undefined) e(state()).toEqual(kept!)
e(f.sha()).toBe(k==="head"?kept! :sha)
}))
