import {execFileSync,spawnSync} from "node:child_process"
import fs from "node:fs"
import {syncBuiltinESMExports as sync} from "node:module"
import {afterEach,expect as e,it,vi} from "vitest"
import {buildPrepareWorkspaceCommands as steps,runPrepareWorkspace as prepare} from "../maintenance/prepare-workspace"
import {runAgentWorktree as run} from "../maintenance/agent-worktree"
import {withTempRepo} from "./helpers/test-state"

afterEach(()=>{vi.restoreAllMocks();sync();})
const line=(cmd:string,argv:string[])=>[cmd,...argv].join(" ")
it.each([
[{},["bootstrap:generated","bootstrap:generated:history"]],
[{GITHUB_ACTIONS:"true"},[]],
[{CI:"1",PHAROS_PREPARE_BOOTSTRAP:"1"},["bootstrap:generated"]],
])("prepare %j",(env,names)=>{
e(steps(env)).toEqual(names.map(name=>["npm",["run",name]]))
const child=vi.fn(()=>({status:1})),n=names.length?1:0
e(prepare({env,runCommand:child})).toEqual({status:n})
e(child).toHaveBeenCalledTimes(n)
})
const install=/install:.*status=7/,isolated=/not isolated/,exists=/already exists/
it.each([
["ok",null,5],["worktree",/create worktree:.*status=7/,0],["runtime",/runtime:.*requires/,2],
["install",install,3],["signal",/install:.*SIGTERM/,3],["spawn",/install:.*spawn failure/,3],
["prepare",install,4],["HEAD",/verify installation:.*identity/,5],["drift",/Tracked output drift/,5],
["node_modules",isolated,5],["worker/node_modules",isolated,5],["shared/contracts/node_modules",isolated,5],
["existing-contracts",/install: Install path already exists/,2],["parent-contracts",/install: Install parent is not isolated/,2],
["--show-toplevel",/identity/,5],["directory",exists,0],["dangling",exists,0],["shallow",/history: shallow/,0],
["workspace",/unsupported literal workspace paths/,0],["rev-list",/history:.*status=7/,0],["unsupported",/bootstrap revision: unsupported/,0],
] as const)("worktree %s",(k,error,n)=>{
const files=Object.fromEntries([".nvmrc","package.json","scripts/maintenance/prepare-workspace.ts"].map(p=>[p,fs.readFileSync(p,"utf8")]))
if(k==="workspace") files["package.json"]=files["package.json"].replace('"worker"','"../outside"')
if(k==="unsupported") files["package.json"]="{}"
withTempRepo("p10",{...files,"package-lock.json":"{}","worker/.gitkeep":"","shared/contracts/.gitkeep":"",
".gitignore":"agents/\n.env.local\n.dev.vars",".env.local":"sentinel",".dev.vars":"sentinel"},cwd=>{
const git=(...av:string[])=>execFileSync("git",["-c","user.name=T","-c","user.email=t@t",...av],
{cwd,encoding:"utf8",env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim()
if(k==="existing-contracts") fs.symlinkSync(cwd,`${cwd}/shared/contracts/node_modules`)
if(k==="parent-contracts"){
fs.rmSync(`${cwd}/shared`,{recursive:true});fs.symlinkSync(cwd,`${cwd}/shared`)
}
git("init");git("config","core.hooksPath","/dev/null");git("add",".");git("commit","-qm","base")
const p=`${cwd}/P`,at=(name:string)=>`${p}/${name}`,av=["--path",p,"--base","HEAD"],calls:string[]=[]
let ready=false,out=""
if(k==="directory") fs.mkdirSync(p)
if(k==="dangling") fs.symlinkSync(`${cwd}/absent`,p)
if(k==="shallow") fs.writeFileSync(`${cwd}/.git/shallow`,git("rev-parse","HEAD"))
const idx=`${cwd}/.git/index`
const snap=()=>[git("status","--porcelain"),git("worktree","list","--porcelain"),fs.readFileSync(idx),fs.statSync(idx).mtimeMs]
const old=snap(),read=vi.spyOn(fs,"readFileSync")
sync()
const go=(apply=false)=>run([...av,...(apply?["--apply"]:[])],{
cwd,output:(text:string)=>{out+=text;},
env:{NODE_ENV:"test",CI:"1",GITHUB_ACTIONS:"1",PHAROS_PREPARE_BOOTSTRAP:"1"},
runCommand(cmd,argv,opts){
if(cmd==="git"){
if(ready&&[3,4].includes(n)) throw Error("late verification")
if(argv[0]===k) return{status:7}
if(ready&&argv.includes(k)) return{status:0,stdout:cwd}
return spawnSync(cmd,argv,opts)
}
calls.push(line(cmd,argv));e(opts.cwd).toBe(p)
for(const name of ["CI","GITHUB_ACTIONS","PHAROS_PREPARE_BOOTSTRAP"]) e(opts.env[name]).toBeUndefined()
if(argv[0]==="--version") return{status:0,stdout:cmd==="node"?(k==="runtime"?"0":process.version):"11.0"}
ready=true
if(k!=="node_modules") fs.mkdirSync(at("node_modules"))
if(["install","signal","spawn"].includes(k)) return{status:k==="install"?7:0,
signal:k==="signal"?"SIGTERM":null,error:k==="spawn"?Error("spawn failure"):undefined}
const res=prepare({env:opts.env,runCommand(cmd,argv){
calls.push(line(cmd,argv));return{status:k==="prepare"?7:0}
}})
if(k==="HEAD") git("-C",p,"update-ref","HEAD",git("rev-parse","HEAD"))
if(k==="drift") fs.writeFileSync(at(".nvmrc"),"0")
if(k.endsWith("node_modules")) fs.symlinkSync(cwd,at(k))
return res
},
})!
const act=()=>{
let plan
try{plan=go();}finally{e(snap()).toEqual(old);}
av[3]=plan.sha;e(fs.existsSync(p)).toBe(false)
git("commit","--allow-empty","-qm","move");return go(true)
}
if(error) e(act).toThrow(error)
else{
act();e(git("-C",p,"rev-parse","--path-format=absolute","--show-toplevel","--git-common-dir","HEAD","--abbrev-ref","HEAD"))
.toBe([fs.realpathSync(p),`${cwd}/.git`,av[3],"HEAD"].join("\n"))
}
e(calls).toEqual(["node --version","npm --version","npm ci --foreground-scripts --ignore-scripts=false",...steps({}).map(([cmd,argv])=>line(cmd,argv))].slice(0,n))
e(out.includes("Prepared ")).toBe(!error)
e(!!fs.lstatSync(p,{throwIfNoEntry:false})).toBe(n!==0||["directory","dangling"].includes(k))
for(const name of [".env.local",".dev.vars"]) e(fs.existsSync(at(name))).toBe(false)
e(read.mock.calls.some(([p])=>/\.(env\.local|dev\.vars)$/.test(String(p)))).toBe(false)
})
})
