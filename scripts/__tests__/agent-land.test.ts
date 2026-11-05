import{execFileSync,spawnSync} from "node:child_process";
import{chmodSync,mkdirSync,readFileSync as read,readlinkSync,renameSync,rmSync,symlinkSync,writeFileSync as put} from "node:fs";
import{join,resolve} from "node:path";
import{afterEach,expect as e,it,vi} from "vitest";
import{buildLandingPlan as plan,parseAgentLandArgs as parse,runAgentLand as run} from "../maintenance/agent-land";
import{withTempRepo} from "./helpers/test-state";

vi.mock("node:child_process",async load=>{
 const cp=await load<typeof import("node:child_process")>();
 return{...cp,spawnSync:vi.fn(cp.spawnSync)};
});
const real=vi.mocked(spawnSync).getMockImplementation()!;
afterEach(()=>{vi.mocked(spawnSync).mockImplementation(real);});
const base="a\nb\nc\nd\ne\nf\n",lane=base.replace("a","l"),late="safety-score-v9-evaluation-build";
const cache="tsconfig.typecheck.tsbuildinfo";
const empty:ReturnType<typeof plan>["review"]["artifacts"]={
 ids:[],checkIds:[],outputs:[],generate:[],check:[],pending:[],validatorOutputs:["v"],
};
function repo(run:(f:ReturnType<typeof setup>)=>void,ids:string[]=[]){
 return withTempRepo("land",{"t/a":base,"t/v":"same","t/del":"old","t/module/index.ts":"old","t/.gitignore":"node_modules\ni\nv\n.cache/\n*.tsbuildinfo\n",msg:"x\n",
   "t/scripts/ci/select-generated-artifacts.mts":`export const selectChangedGeneratedArtifactIds=p=>p.join()==='a'?${JSON.stringify(ids)}:[];`,
   "t/scripts/lib/automation-registry.mjs":`export const selectGeneratedArtifacts=({only})=>{if(!only.length)throw Error('all');return (only.includes('leaf')?['dep',...only]:only).map(id=>({id,bootstrap:id!=='live',checkable:id!=='dep',outputPaths:[id+'.out']}))};`,
   "t/scripts/maintenance/run-generated-artifacts.ts":"export const buildGeneratedArtifactExecutionPhases=o=>[o];",
 },r=>run(setup(r)));
}
function setup(root:string){
 const t=join(root,"t"),l=join(root,"l"),msg=join(root,"msg");
 const git=(cwd:string,...args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null",...args],
  {cwd,encoding:"utf8",env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}});
 git(t,"init","-q");
 for(const [k,v] of [["user.name","F"],["user.email","f@x"],["commit.gpgSign","false"]]) git(t,"config",k,v);
 const commit=(c=t)=>{git(c,"add",".");git(c,"commit","-qm","f");};
 commit();
 git(t,"worktree","add","--detach",l,"HEAD");
 symlinkSync(resolve("node_modules"),join(t,"node_modules"));
 const args=["--lane",l,"--target",t,"--review",join(root,"review"),"--message-file",msg];
 const write=(name:string,text:string|Buffer,cwd=l)=>put(join(cwd,name),text);
 const rt={planArtifacts:()=>empty,runCommand:vi.fn(),log:vi.fn()};
 const save=()=>{const p=plan(parse(args),rt);put(args[5],JSON.stringify(p.review));return p.review.paths;};
 const apply=()=>run([...args,"--apply"],rt);
 const index=(cwd:string)=>git(cwd,"rev-parse","--path-format=absolute","--git-path","index").trim();
 write("a",lane);
 const sha=(c=t)=>git(c,"rev-parse","HEAD");
 const snap=()=>[args[1],args[3]].map(c=>[sha(c),read(index(c)),git(c,"diff","--binary","HEAD"),
   git(c,"ls-files","-o","--exclude-standard","-z").split("\0").filter(Boolean).map(p=>[p,read(join(c,p))])]);
 return{t,l,msg,git,args,write,rt,save,apply,index,sha,commit,snap};
}
it.each([false,true,"i","fd","df","fl",cache,"cold","worker"])("land %s",g=>repo(f=>{
 const o=g==="i"?"i" :"out";
 if(g) f.rt.planArtifacts=()=>({...empty,ids:["f"],outputs:[o]});
 f.rt.runCommand.mockImplementation(c=>{
   if(c.stage==="generation") f.write(o,"ok",f.t);
   if(c.stage!=="focused checks") return;
   if(g===cache) f.write(cache,"x",f.t);
   if(g==="cold"){f.write("tmp",read(join(f.t,"v")),f.t);renameSync(join(f.t,"tmp"),join(f.t,"v"));}
   if(g==="worker") for(const role of ["public","heavy"]){const p=join(f.t,`.cache/release-check/worker-bundle-${role}`);mkdirSync(p,{recursive:true});put(join(p,"a"),"x");}
 });
 f.write("a",base.replace("f","t"),f.t);f.commit();
 f.write(":(glob)*",Buffer.from([0,255]));f.write("exe","old");chmodSync(join(f.l,"exe"),0o755);
 symlinkSync("/outside/missing",join(f.l,"link"));rmSync(join(f.l,"del"));
 symlinkSync(f.t,join(f.l,"d l"));
 if(g==="fl") symlinkSync("a",join(f.l,"del"));
 if(g==="fd"){mkdirSync(join(f.l,"del"));f.write("del/index.ts","n");}
 if(g==="df"){rmSync(join(f.l,"module"),{recursive:true});f.write("module","n");}
 const index=f.index(f.l),old=read(index);
 run(f.args,f.rt);e(read(index)).toEqual(old);e(f.rt.runCommand).not.toHaveBeenCalled();
 const ps=f.save();f.apply();
 e(f.rt.runCommand).toHaveBeenCalledWith({stage:"focused checks",executable:"npm",cwd:f.t,args:["run","check:focused","--",
   ...[...ps,...(g?[o] :[])].sort().flatMap(p=>["--file",p])]});
 e(read(join(f.t,"a"),"utf8")).toBe(lane.replace("f","t"));
 e(f.git(f.t,"status","--porcelain")).toBe("");
 e(f.git(f.t,"ls-tree","HEAD")).toMatch(/100755.*exe[\s\S]*120000.*link/);
 e(read(join(f.t,":(glob)*"))).toEqual(Buffer.from([0,255]));
 e(readlinkSync(join(f.t,"d l"))).toBe(f.t);
 if(g==="fl") e(readlinkSync(join(f.t,"del"))).toBe("a");
 if(g==="fd") e(read(join(f.t,"del/index.ts"),"utf8")).toBe("n");
 if(g==="df") e(read(join(f.t,"module"),"utf8")).toBe("n");
}));
it.each(["content","path","mode","message","head","index","lane-index","same","other","ahead","empty","dirty","untracked",
 ...["MERGE_HEAD","CHERRY_PICK_HEAD","rebase-merge","rebase-apply"].flatMap(m=>["l:"+m,"t:"+m])])("reject %s",k=>repo(f=>{
 f.save();
 if(k==="content"||k==="path") f.write(k==="content"?"a" :"extra","n");
 if(k==="mode") chmodSync(join(f.l,"a"),0o755);
 if(k==="message") put(f.msg,"y\n");
 if(k==="head") f.git(f.t,"commit","--allow-empty","-qm","moved");
 if(k.endsWith("index")){
   const cwd=k==="index"?f.t :f.l;
   f.write("a","s",cwd);f.git(cwd,"add","a");f.write("a",cwd===f.t?base :lane,cwd);
 }
 if(k==="same") f.args[3]=f.l;
 if(k==="other"){const p=join(f.t,"..","o");f.git(f.t,"clone","-q",f.t,p);f.args[3]=p;}
 if(k==="ahead"){f.commit(f.l);f.write("a","n");}
 if(k==="empty") f.write("a",base);
 if(k==="dirty"||k==="untracked") f.write(k==="dirty"?"a" :"u","x",f.t);
 if(k.includes(":")){const [x,m]=k.split(":"),p=join(f.index(x==="l"?f.l :f.t),"..",m);if(m.startsWith("rebase")) mkdirSync(p);else put(p,f.sha());}
 const old=f.snap(),why=k.endsWith("index")?"git diff" :k==="same"||k==="other"?"Require distinct" :k==="ahead"?"git merge-base"
   :k==="empty"?"Empty lane" :k.includes(":")?"In-progress" :k==="dirty"||k==="untracked"?"Target must be clean" :"Review";
 e(f.apply).toThrow(why);e(f.rt.runCommand).not.toHaveBeenCalled();e(f.snap()).toEqual(old);
}));
it("conflict",()=>repo(f=>{
 f.write("a","t\n",f.t);f.commit();
 f.save();e(f.apply).toThrow(/cherry-pick/);
 e(f.git(f.t,"show",":2:a")).toBe("t\n");
 e(f.git(f.t,"show",":3:a")).toBe(lane);
}));
it.each<string[]>([[],[late],["leaf",late],["live"]])("plan %j",(...ids)=>repo(f=>{
 const build=()=>plan(parse(f.args));
 if(ids.includes("live")) e(build).toThrow(/Not offline bootstrap-safe: live/);
 else{
   const full=ids.includes("leaf"),only=full?["dep","leaf"] :[],check=full?["leaf"] :[];
   const p=build(),runner=["--import","tsx","scripts/maintenance/run-generated-artifacts.ts"];
   const cmd=(stage:string,executable:string,args:string[])=>({stage,executable,args,cwd:f.t});
   e(p.review.artifacts).toEqual({ids:only,checkIds:check,outputs:only.map(id=>`${id}.out`),
     generate:full?[{bootstrap:true,only}] :[],check:full?[{check:true,integrityOnly:true,only:check}] :[],pending:[late],validatorOutputs:["stablecoin-client-registry.out"]});
   e(p.commands).toEqual([
     ...(full?[cmd("generation",process.execPath,[...runner,"--bootstrap","--only=dep,leaf"]),
       cmd("artifact checks",process.execPath,[...runner,"--check","--integrity-only","--only=leaf"])] :[]),
     cmd("focused checks","npm",["run","check:focused","--","--file","a"]),cmd("unused code","npm",["run","check:unused-code"]),
   ]);
 }
},ids));
it.each([
 ["generation",process.execPath,0,7,null],["artifact checks",process.execPath,1,7,null],
 ["focused checks","npm",0,7,null],["unused code","npm",1,7,null],
 ["focused checks","npm",0,0,"SIGTERM"],["focused checks","npm",0,0,null],["git diff","git",0,1,null],
] as const)("child %s/%s/%s/%s/%s",(stage,cmd,skip,status,signal)=>repo(f=>{
 if(cmd===process.execPath) f.rt.planArtifacts=()=>({...empty,ids:["f"],checkIds:["f"]});
 if(cmd==="git") f.write("extra","n");
 f.save();const sha=f.sha();
 vi.mocked(spawnSync).mockImplementation((exe,args,opts)=>exe==="git"&&!(cmd==="git"&&args?.includes("--no-index"))?real(exe,args,opts)
   :{pid:0,output:[],stdout:Buffer.alloc(0),stderr:Buffer.from("x"),status:skip-- > 0?0 :status,
     signal,error:status===0&&!signal?Error() :undefined});
 e(()=>run([...f.args,"--apply"],{planArtifacts:f.rt.planArtifacts,log:f.rt.log}))
   .toThrow(`${stage}: ${cmd} failed (status ${status}, signal ${signal ?? "none"})`);
 e(f.sha()).toBe(sha);
}));
it.each(["head","index","source","outputs","message","review","output","plan","ignored-write","ignored-validator","v"])("retains %s",k=>repo(f=>{
 let n=0;const scope=k==="output"||k==="plan"||k==="ignored-write";
 f.rt.planArtifacts=()=>({...empty,ids:["f"],outputs:[k==="plan"&&n++ > 2?"other" :k.startsWith("ignored")?"out" :"i"]});
 const path=k==="index"?f.index(f.t) :k==="message"?f.msg :k==="review"?f.args[5] :join(f.t,k==="v"?"v" :k==="outputs"||k==="ignored-validator"?"i" :"a");
 const state=()=>k==="head"?f.sha() :read(path);
 let kept:ReturnType<typeof state>;
 f.rt.runCommand.mockImplementation(c=>{
   if(c.stage==="generation") f.write(k==="output"?"rogue" :k==="ignored-write"?cache :k==="ignored-validator"?"out" :"i","ok",f.t);
   if(c.stage !== "focused checks"||scope) return;
   if(k==="head") f.commit();
   else if(k==="index") f.git(f.t,"update-index","--chmod=+x","a");
   else put(path,k==="review"?"{}" :"mutated");
   kept=state();
 });
 if(k==="ignored-write") f.write(cache,"old",f.t);
 f.save();const sha=f.sha();
 e(f.apply).toThrow(k==="plan"?"Combined artifact ownership" :k==="output"||k==="ignored-write"?"Undeclared output write" :k==="v"?"Validator artifact content" :undefined);
 if(scope) e(f.rt.runCommand).toHaveBeenCalledTimes(k==="plan"?0 :1);
 if(kept! !== undefined) e(state()).toEqual(kept!);
 e(f.sha()).toBe(k==="head"?kept! :sha);
}));
