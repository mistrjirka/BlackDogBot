#!/usr/bin/env python3
"""Compare live Ornith function-call generation for exact replace vs unified diff.
Read-only test: generated calls are scored, never executed."""
import json,pathlib,urllib.request,time,statistics
trace=pathlib.Path.home()/'.blackdogbot/logs/llm-trace.jsonl'
tools=None
for line in trace.open(errors='replace'):
 try:d=json.loads(line)
 except:continue
 ts=(d.get('requestBody') or {}).get('tools') or []
 if len(ts)==71:tools=ts;break
assert tools
lookup={(t.get('function') or t)['name']:t for t in tools}
patch={"type":"function","function":{"name":"apply_patch","description":"Apply a context-checked unified diff across one or more files in cwd.","parameters":{"type":"object","properties":{"patch":{"type":"string","description":"Unified diff with ---/+++ paths and @@ hunks"},"cwd":{"type":"string","description":"Base directory"}},"required":["patch"]}}}
cases=[
 ("replace","Replace exactly the single line 'value = 1' with 'value = 2' in /home/jirka/project/config.py.",["edit_file"],lambda x:x.get("filePath")=="/home/jirka/project/config.py" and x.get("oldString")=="value = 1" and x.get("newString")=="value = 2"),
 ("patch","Apply a one-line code change in config.py inside /home/jirka/project: change the existing line 'value = 1' into 'value = 2'. Generate a valid unified diff using a/config.py and b/config.py.",["apply_patch"],lambda x:x.get("cwd")=="/home/jirka/project" and "-value = 1" in x.get("patch","") and "+value = 2" in x.get("patch","") and "@@" in x.get("patch","")),
 ("old_once","Set a one-time reminder 'Review draft' for October 30 2026 at 14:30. Tool list: send_message. Notify user. Instructions: 'Remind the user to review the draft'.",["add_once"],lambda x: x.get("year")==2026 and x.get("month")==10 and x.get("day")==30 and x.get("hour")==14 and x.get("minute")==30),
 ("old_interval","Schedule daily reminder 'Daily recap' every 24 hours with offset 8:00, timezone Europe/Prague; instructions 'Send the daily recap', tools send_message, notifyUser true.",["add_interval"],lambda x:x.get("every",{}).get("hours")==24 and x.get("offsetFromDayStart",{}).get("hours")==8),
]
create={"type":"function","function":{"name":"schedule_create","description":"Create a recurring or one-time task. kind once requires exact date fields; interval requires every and offsetFromDayStart.","parameters":{"type":"object","properties":{"kind":{"type":"string","enum":["once","interval"]},"name":{"type":"string"},"description":{"type":"string"},"instructions":{"type":"string"},"tools":{"type":"array","items":{"type":"string"}},"year":{"type":"integer"},"month":{"type":"integer"},"day":{"type":"integer"},"hour":{"type":"integer"},"minute":{"type":"integer"},"notifyUser":{"type":"boolean"},"every":{"type":"object","properties":{"hours":{"type":"integer"},"minutes":{"type":"integer"}}},"offsetFromDayStart":{"type":"object","properties":{"hours":{"type":"integer"},"minutes":{"type":"integer"}}},"timezone":{"type":"string"}},"required":["kind"]}}}
cases.extend([
 ("merged_once",cases[2][1],["schedule_create"],lambda x:x.get("kind")=="once" and x.get("year")==2026 and x.get("month")==10 and x.get("day")==30 and x.get("hour")==14 and x.get("minute")==30),
 ("merged_interval",cases[3][1],["schedule_create"],lambda x:x.get("kind")=="interval" and x.get("every",{}).get("hours")==24 and x.get("offsetFromDayStart",{}).get("hours")==8),
])
selected=dict(lookup);selected["apply_patch"]=patch;selected["schedule_create"]=create
out=pathlib.Path.home()/'.blackdogbot/benchmarks/compaction-20261026/file-tool-generation.jsonl'
with out.open('w') as f:
 for label,prompt,names,check in cases:
  req={"model":"local","messages":[{"role":"system","content":"Choose the supplied tool and populate all necessary arguments. Do not claim execution."},{"role":"user","content":prompt}],"tools":[selected[n] for n in names],"tool_choice":"required","max_tokens":420,"stream":False,"chat_template_kwargs":{"enable_thinking":False}}
  start=time.monotonic()
  try:
   request=urllib.request.Request('http://127.0.0.1:2345/v1/chat/completions',data=json.dumps(req).encode(),headers={"Content-Type":"application/json"})
   r=json.load(urllib.request.urlopen(request,timeout=135))
   calls=(r.get("choices") or [{}])[0].get("message",{}).get("tool_calls") or []
   action=(calls[0].get("function") or {}) if calls else {}
   try:args=json.loads(action.get("arguments") or "{}")
   except:args={}
   okay=action.get("name")==names[0] and bool(check(args))
   result={"case":label,"seconds":round(time.monotonic()-start,1),"tool_name":action.get("name"),"arguments":args,"pass":okay,"completion_tokens":r.get("usage",{}).get("completion_tokens")}
  except Exception as e:result={"case":label,"error":str(e)[:150],"seconds":round(time.monotonic()-start,1)}
  f.write(json.dumps(result,ensure_ascii=False)+"\n");f.flush()
  print('BENCH',label,'PASS',result.get('pass'),'SECONDS',result['seconds'],'error',result.get('error'),flush=True)
print('Saved results:',out)
