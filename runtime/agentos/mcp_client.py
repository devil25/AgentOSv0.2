"""Minimal MCP stdio client for configured, explicitly trusted servers.
Only tools named in allowed_tools can be called. Server processes inherit the
current Windows user's permissions; configure only servers you trust.
"""
import json, subprocess
from .paths import CONFIG

class MCPError(RuntimeError): pass

def _server(name):
    f=CONFIG/"mcp_servers.json"
    if not f.exists(): raise MCPError("mcp_servers.json not configured")
    data=json.loads(f.read_text(encoding="utf-8"))
    cfg=data.get("servers",{}).get(name)
    if not cfg: raise MCPError("Unknown MCP server")
    if not cfg.get("enabled",False): raise MCPError("MCP server is disabled")
    command=cfg.get("command")
    args=cfg.get("args",[])
    if not command or not isinstance(args,list) or not all(isinstance(x,str) for x in args): raise MCPError("Invalid server command/args")
    return cfg,command,args

def _request(proc,obj,timeout=20):
    proc.stdin.write(json.dumps(obj,ensure_ascii=False)+"\n"); proc.stdin.flush()
    while True:
        line=proc.stdout.readline()
        if not line: raise MCPError("MCP server closed stdout: "+proc.stderr.read(1000))
        try: msg=json.loads(line)
        except json.JSONDecodeError: continue
        if msg.get("id")==obj.get("id"):
            if "error" in msg: raise MCPError(str(msg["error"]))
            return msg.get("result",{})

def _connect(name):
    cfg,command,args=_server(name)
    proc=subprocess.Popen([command,*args],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding="utf-8",bufsize=1)
    try:
        _request(proc,{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"AgentOS","version":"0.2.0-dev"}}})
        proc.stdin.write(json.dumps({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})+"\n");proc.stdin.flush()
        return proc,cfg
    except Exception:
        proc.kill(); raise

def list_tools(name):
    proc,cfg=_connect(name)
    try:
        result=_request(proc,{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
        allowed=set(cfg.get("allowed_tools",[]))
        return [{"name":t.get("name"),"description":t.get("description",""),"allowed":t.get("name") in allowed,"inputSchema":t.get("inputSchema",{})} for t in result.get("tools",[])]
    finally: proc.terminate()

def call_tool(name,tool,arguments):
    proc,cfg=_connect(name)
    try:
        allowed=set(cfg.get("allowed_tools",[]))
        if tool not in allowed: raise MCPError("Tool is not in allowed_tools")
        return _request(proc,{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":arguments or {}}})
    finally: proc.terminate()
