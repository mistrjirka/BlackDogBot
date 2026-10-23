import { Client } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import fs from "node:fs";
const env=fs.readFileSync(process.env.HOME+"/.blackdogbot/scrapling.env","utf8");
const token=env.match(/^SCRAPLING_MCP_AUTH_TOKEN=(.+)$/m)?.[1];
if(!token)throw Error("Missing token");
const port=process.argv[2]||"18733";
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:"+port+"/mcp"),{requestInit:{headers:{Authorization:"Bearer "+token}}});
const client=new Client({name:"scrapling-verify",version:"1.0.0"});
const begin=Date.now();
try{
 await client.connect(transport);
 const {tools}=await client.listTools();
 console.log("CONNECT",tools.length,"tools",tools.map(t=>t.name).join(","), "ms",Date.now()-begin);
 for(const t of tools.filter(t=>["browser_fetch_once","browser_open","browser_fetch","browser_screenshot","close_session"].includes(t.name)))
  console.log("SCHEMA",t.name,"required",JSON.stringify(t.inputSchema?.required),"props",JSON.stringify(Object.keys(t.inputSchema?.properties||{})));
 const t=tools.find(t=>t.name==="browser_fetch_once");
 if(!t)throw Error("browser_fetch_once missing");
 const r=await client.callTool({name:t.name,arguments:{url:"https://quotes.toscrape.com/js/",wait_selector:".quote"}});
 const result=JSON.stringify(r.structuredContent??r.content??[]);
 console.log("JS_RENDER","error",r.isError??false,"len",result.length,"hasEinstein",result.includes("Albert Einstein"),"sample",result.slice(0,360),"ms",Date.now()-begin);
 if(r.isError||!result.includes("Albert Einstein"))throw Error("JavaScript-rendered quotation absent");

 const open=await client.callTool({name:"browser_open",arguments:{}});
 const s=JSON.stringify(open.structuredContent??open.content??[]);
 const sessionId=open.structuredContent?.session_id || JSON.parse(open.content?.[0]?.text||"{}").session_id;
 console.log("SESSION", "error",open.isError,"opened",Boolean(sessionId),"response",s.slice(0,380));
 if(!sessionId)throw Error("Browser open returned no session ID");
 try{
  const page=await client.callTool({name:"browser_fetch",arguments:{session_id:sessionId,url:"https://example.com"}});
  console.log("SESSION_FETCH",page.isError,JSON.stringify(page.structuredContent??page.content??[]).slice(0,220));
  const pic=await client.callTool({name:"browser_screenshot",arguments:{session_id:sessionId,image_type:"png"}});
  console.log("SCREENSHOT","error",pic.isError,"parts",(pic.content||[]).map(p=>({type:p.type,mimeType:p.mimeType,base64size:p.type==="image"?p.data?.length:0})));
  if(pic.isError||!(pic.content||[]).some(p=>p.type==="image"&&p.data?.length>100))throw Error("Screenshot not provided as inline MCP image");
 }finally{await client.callTool({name:"close_session",arguments:{session_id:sessionId}});}

}finally{await client.close();}
