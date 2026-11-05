import {expect as e,it} from "vitest"
import {evaluateCliArgsPolicy as check,sourceUsesProcessArgv as uses} from "../ci/check-cli-args-policy.ts"
import {CLI_ARGV_POLICY} from "../lib/cli-argv-policy.mjs"

const path="scripts/operator.mjs",parserPath="scripts/parser.ts",entry={path,parserPath:path}
const parser='import { parseStrictCliArgs } from "./lib/cli-args.mjs"; parseStrictCliArgs(process.argv);'
const reason="Reports repository state without persistent mutation."
const bad=`Strict parser ${path} must import scripts/lib/cli-args.mjs and call parseStrictCliArgs().`
it.each(["land","worktree"])("strict agent %s",name=>{
const path=`scripts/maintenance/agent-${name}.ts`
e(CLI_ARGV_POLICY.strict.filter(entry=>entry.path===path)).toEqual([{path,parserPath:path}])
})
it.each([
['"process.argv"; // process.argv',false],['process.argv',true],
['process["argv"]',true],['\\u0070rocess.argv',true],['processArgs',false],
])("argv discovery: %s → %s",(source,want)=>e(uses(source)).toBe(want))
it.each([
[[],[],parser,[`Unclassified process.argv entrypoint: ${path}`]],
...["process.argv",`/* ${parser} */ process.argv;`,`const help = \`${parser}\`; process.argv;`]
.map(source=>[[entry],[],source,[bad]] as const),
[[],[{path,category:"operator",reason:"temporary"}],parser,[
`Invalid CLI exemption category for ${path}: operator`,`CLI exemption ${path} must have a specific audit reason.`,
]],
[[entry,entry],[{path,category:"build",reason}],parser,[
`Duplicate strict CLI policy entry: ${path}`,`CLI path cannot be both strict and exempt: ${path}`,
]],
[[entry],[],parser,[]],[[{path,parserPath}],[],'import "./bridge"; process.argv;',[]],
[[{path,parserPath}],[],'// import "./parser.ts";\nprocess.argv;',[
`Strict CLI entrypoint ${path} does not import its declared parser ${parserPath}.`,
]],
] as const)("strict policy %#",(strict,exemptions,source,errors)=>{
const sources:Record<string,string>={[path]:source,[parserPath]:parser,
"scripts/bridge.mjs":'import "./operator.mjs"; export { parse } from "./parser.js";'}
e(check({policy:{strict,exemptions},discoveredPaths:[path],readSource:p=>{
if(!(p in sources)) throw Error("Missing source");return sources[p]
}}).errors).toEqual(errors)
})
it("unsorted strict/exempt",()=>{
const paths=["z","a"].map(n=>`scripts/${n}-operator.mjs`),exempt=["z","a"].map(n=>`scripts/ci/${n}-report.mjs`)
e(check({discoveredPaths:[...paths,...exempt],policy:{
strict:paths.map(path=>({path,parserPath:path})),exemptions:exempt.map(path=>({path,category:"read-only",reason})),
},readSource:()=>parser})).toEqual({errors:[],counts:{discovered:4,strict:2,exempt:2}})
})
