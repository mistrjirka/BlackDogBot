#!/usr/bin/env python3
"""Isolated first-action blackboard instruction A/B test against the running local model.

No bot session, MCP browser, files, or Telegram state is modified. The local model
receives a synthetic transcript ending in a large-result stub and may choose among
faked tool definitions. No tools are actually executed.
"""
import argparse
import os
import json
import random
import time
import urllib.request
from collections import Counter

API = 'http://127.0.0.1:2345/v1'
NAME = 'mcp_stealth_browser_read_html_67'

TOOLS = [
  {'type':'function','function':{'name':'mcp.stealth.browser_read_html','description':'Read current page cleaned HTML. Has no offset or paging parameter.',
    'parameters':{'type':'object','properties':{'mode':{'type':'string','enum':['form','text','full']},'browser':{'type':'string','enum':['main','support']},'reasoning':{'type':'string'}},'required':[]}}},
  {'type':'function','function':{'name':'mcp.searxng.searxng_web_search','description':'Search the web for a new list of URLs.',
    'parameters':{'type':'object','properties':{'query':{'type':'string'}},'required':['query']}}},
  {'type':'function','function':{'name':'mcp.stealth.browser_read_text','description':'Read the visible text of a page.',
    'parameters':{'type':'object','properties':{'selector':{'type':'string'},'browser':{'type':'string'}},'required':[]}}},
  {'type':'function','function':{'name':'inspect_variable','description':'Read a slice of a saved blackboard variable, or list existing names. Does not fetch a page.',
    'parameters':{'type':'object','properties':{'name':{'type':'string'},'offset':{'type':'integer'},'maxChars':{'type':'integer'}},'required':[]}}},
  {'type':'function','function':{'name':'run_code','description':'Run synchronous JavaScript using saved blackboard variables directly; print short relevant excerpts.',
    'parameters':{'type':'object','properties':{'code':{'type':'string'}},'required':['code']}}}
]

NOTE_OLD = 'Full data is stored in this run\'s blackboard, not a shell variable. Use inspect_variable with name "{name}" to read it, or {{"type":"variable","name":"{name}"}} only in an input field that supports references; run_cmd cannot read it.'
NOTE_WORKING = 'PREVIEW ONLY: this tool ALREADY RETURNED a large result; its full data is stored as {name}. Do NOT call the same tool again to read beyond this preview. Use run_code: print({name}.slice(1200, 2400)) or print({name}.includes("target phrase")). Alternatively use inspect_variable with name "{name}" and an offset. It is not a shell variable.'
NOTE_COMPACT = 'SAVED TO VARIABLE: {name}. The full tool result was successfully fetched and saved. Preview is only the beginning. To see later text call inspect_variable with name="{name}" and offset; to search/filter use run_code with {name}. Do not call browser_read_html again: it re-fetches the same page from the beginning.'

def make_stub(variant, case):
    name = NAME if case == 'html' else 'mcp_searxng_searxng_web_search_67'
    preview = ('"<html>\\n<h1>PS4 Exploit Chart</h1>\\n<p>Supported exploits by firmware</p>\\n'
               '<table><tbody><tr><th>Firmware</th><th>Userland Exploit(s)</th><th>Kernel Exploit(s)…"') if case == 'html' else '[{"title":"result 1","url":"https://example.org/1"}, ...]'
    obj = {'variable':name, 'type':'string' if case=='html' else 'array','sizeBytes':60441}
    if variant=='old':
        obj['note']=NOTE_OLD.format(name=name)
    if variant=='working':
        obj['note']=NOTE_WORKING.format(name=name)
    if variant=='compact':
        obj['savedToVariable']=name
        obj['previewOnly']=True
        obj['note']=NOTE_COMPACT.format(name=name)
    if variant=='directive':
        obj['savedToVariable']=name
        obj['previewOnly']=True
        obj['readNextWith']={'tool':'inspect_variable','arguments':{'name':name,'offset':1200,'maxChars':4000}}
        obj['searchWith']={'tool':'run_code','arguments':{'code':f'const x = {name}; print(x.slice(1200,2400))'}}
        obj['note']='SAVED TO VARIABLE. The page is already fetched. Do not call browser_read_html again to obtain later characters. The preview is intentionally incomplete.'
    obj['preview']=preview
    if variant=='candidate':
        obj['savedToVariable']=name
        obj['previewOnly']=True
        obj['readNextWith']={'tool':'inspect_variable','arguments':{'name':name,'offset':1000 if case=='html' else 0,'maxChars':4000}}
        obj['searchWith']={'tool':'run_code','arguments':{'code':f'print({name}.slice(1000, 2500))' if case=='html' else f'print(JSON.stringify({name}.slice(0, 3)).slice(0, 2000))'}}
        obj['note']=f'SAVED TO VARIABLE: {name}. The complete tool result is already in the blackboard; preview is only a short sample. Use readNextWith to read more, or searchWith to filter/inspect it. Do NOT call the source tool again just to read beyond preview. Use {{"type":"variable","name":"{name}"}} only in an input field supporting references. This is not a shell variable; run_cmd cannot read it.'
    if variant=='candidate2':
        obj['savedToVariable']=name
        obj['previewOnly']=True
        obj['readNextWith']={'tool':'inspect_variable','arguments':{'name':name,'offset':1200 if case=='html' else 0,'maxChars':4000}}
        obj['searchWith']={'tool':'run_code','arguments':{'code':f'const x = {name}; print(x.slice(1200, 2400))' if case=='html' else f'print(JSON.stringify({name}.slice(0, 3)).slice(0, 2000))'}}
        obj['note']=f'SAVED TO VARIABLE: {name}. The complete result is already stored. Do not call the source tool again to obtain later characters; this preview is intentionally incomplete. Use readNextWith to inspect or searchWith to filter. To pass the full value use {{"type":"variable","name":"{name}"}} only in supported inputs. This is not a shell variable; run_cmd cannot read it.'
    if variant=='banner':
        return 'SAVED TO VARIABLE: '+name+'\nFULL TOOL RESULT IS STORED (not truncated). PREVIEW ONLY. To continue use inspect_variable(name="'+name+'", offset=1200, maxChars=4000) or run_code; do NOT fetch the page again.\n'+json.dumps(obj)
    return json.dumps(obj)

def make_messages(variant,case):
    if case=='html':
        task='I need the PS4 firmware 12.50 entry in the exploit compatibility table, especially whether the kernel exploit is supported. Continue reading the table after the initial headers; cite actual evidence.'
        fn='mcp.stealth.browser_read_html'; call={'mode':'full','browser':'main'}
    else:
        task='From the search result list already retrieved, pick the URLs related to PS4 firmware 12.50. The first preview result is unrelated; inspect the rest.'
        fn='mcp.searxng.searxng_web_search'
        call={'query':'PS4 12.50 firmware jailbreak exploit'}
    return [
      {'role':'system','content':'You are Nate, a research agent. Connected browser and saved blackboard tools are available. Large tool outputs are captured in a named blackboard variable; inspect_variable reads slices and run_code can process saved data. Use tools to gather missing evidence. One tool call at a time.'},
      {'role':'user','content':task},
      {'role':'assistant','tool_calls':[{'type':'function','id':'call_html','function':{'name':fn,'arguments':json.dumps(call)}}]},
      {'role':'tool','tool_call_id':'call_html','content':json.dumps([{'type':'text','text':make_stub(variant,case)}])},
    ]

def run_one(model,variant,case,tools):
    body={'model':model,'messages':make_messages(variant,case),'tools':tools,'tool_choice':'auto','max_tokens':260,'stream':False}
    start=time.monotonic()
    data=json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(API+'/chat/completions',data=data,headers={'Content-Type':'application/json'}),timeout=120) as response:
        result=json.load(response)
    msg=result['choices'][0]['message']
    calls=msg.get('tool_calls') or []
    names=[c['function']['name'] for c in calls]
    correct=bool(names) and all(x in ('inspect_variable','run_code') for x in names)
    return {'variant':variant,'case':case,'toolNames':names,'correct':correct,'elapsedSec':round(time.monotonic()-start,2),
       'arguments':[str(c['function'].get('arguments',''))[:310] for c in calls],
       'text':str(msg.get('content') or '')[:220], 'finishReason':result['choices'][0].get('finish_reason')}

def load_production_tools():
    trace=os.path.expanduser('~/.blackdogbot/logs/llm-trace.jsonl')
    last=None
    with open(trace) as f:
        for line in f:
            try:
                obj=json.loads(line)
                tools=obj.get('requestBody',{}).get('tools',[])
                if len(tools)>10: last=tools
            except (ValueError,KeyError):pass
    if not last:raise RuntimeError('No saved tool catalog in trace')
    return last

def main():
    p=argparse.ArgumentParser();p.add_argument('--trials',type=int,default=2);p.add_argument('--cases',nargs='+',choices=['html','search'],default=['html','search']);p.add_argument('--variants',nargs='+',default=['old','working','compact','directive','banner']);p.add_argument('--output',default='/tmp/blackdogbot-blackboard-eval.json');p.add_argument('--production-tools',action='store_true',help='Use the real tool catalog saved in local LLM trace (no chat history)');a=p.parse_args()
    with urllib.request.urlopen(API+'/models',timeout=10) as resp: model=json.load(resp)['data'][0]['id']
    tools=load_production_tools() if a.production_tools else TOOLS
    print('MODEL',model,'TOOLS',len(tools),flush=True)
    jobs=[(v,c,i) for v in a.variants for c in a.cases for i in range(a.trials)]
    random.Random(43).shuffle(jobs)
    results=[]
    for n,(v,c,i) in enumerate(jobs,1):
        try:r=run_one(model,v,c,tools)
        except Exception as e:r={'variant':v,'case':c,'correct':False,'error':str(e)[:280]}
        r['trial']=i;results.append(r)
        print(f'{n}/{len(jobs)} {v:10} {c:6} {str(r.get("toolNames", r.get("error"))):52} correct={r["correct"]} {r.get("elapsedSec",0)}s',flush=True)
    scores=Counter((r['variant'],r['case']) for r in results if r['correct'])
    print('SCORES',json.dumps({f'{v}/{c}':f'{scores[v,c]}/{a.trials}' for v in a.variants for c in a.cases}),flush=True)
    with open(a.output,'w') as f:json.dump({'model':model,'results':results,'scores':{f'{v}/{c}':scores[v,c] for v in a.variants for c in a.cases}},f,indent=2)
    print('REPORT',a.output,flush=True)
if __name__=='__main__':main()
