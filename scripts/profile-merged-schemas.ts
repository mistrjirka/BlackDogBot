import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { processTool, scheduleCreateTool, scheduleEditTool } from "../src/tools/merged-tools.tool.js";
import { applyPatchTool } from "../src/tools/apply-patch.tool.js";
import { conciseToolDescriptions } from "../src/agent/tool-descriptions.js";
const rows=fs.readFileSync(path.join(os.homedir(),".blackdogbot/logs/llm-trace.jsonl"),"utf8").split("\n");
let old:any[]=[];
for(const line of rows){try{const x=JSON.parse(line);const t=x.requestBody?.tools||[];if(t.length===71){old=t;break;}}catch{}}
const removed=new Set(["run_cmd_input","get_cmd_status","get_cmd_output","wait_for_cmd","stop_cmd","add_once","add_interval","edit_once","edit_interval"]);
const created=Object.entries({process:processTool,schedule_create:scheduleCreateTool,schedule_edit:scheduleEditTool,apply_patch:applyPatchTool});
const list=old.filter(t=>!removed.has(t.function.name));
for(const [name,t] of created)list.push({type:"function",function:{name,description:t.description,parameters:zodToJsonSchema(t.inputSchema,{target:"openApi3"})}});
const newList=list.map((t)=>{const {function:func}=t;const temp=conciseToolDescriptions({[func.name]:{inputSchema:{},description:func.description} as any});return {...t,function:{...func,description:temp[func.name].description}}}).sort((a,b)=>a.function.name.localeCompare(b.function.name,"en"));
const location=path.join(os.homedir(),".blackdogbot/benchmarks/compaction-20261026/merged-tool-schema.json");
fs.writeFileSync(location,JSON.stringify(newList));
console.log(JSON.stringify({tools:newList.length,bytes:Buffer.byteLength(JSON.stringify(newList)),path:location}));
