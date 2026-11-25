from pathlib import Path
from urllib.parse import urlparse
from .paths import safe_workspace_path, WORKSPACE
from .catalog import list_skills, list_plugins, list_mcp
from .audit import audit
from .mcp_client import list_tools as mcp_list_tools, call_tool as mcp_call_tool
from .plugin_manager import call_plugin_tool

def execute(action, args):
    if not isinstance(args,dict): raise ValueError("arguments must be an object")
    if action=="runtime.status": return {"ok":True,"version":"0.1.0","runtime":"online"}
    if action=="skills.list": return {"ok":True,"items":list_skills()}
    if action=="plugins.list": return {"ok":True,"items":list_plugins()}
    if action=="mcp.list": return {"ok":True,"items":list_mcp()}
    if action=="mcp.tools":
        return {"ok":True,"items":mcp_list_tools(args.get("server", ""))}
    if action=="mcp.call":
        result=mcp_call_tool(args.get("server", ""),args.get("tool", ""),args.get("arguments",{}))
        return {"ok":True,"result":result}
    if action=="skills.read":
        name=args.get("name", "")
        import re
        if not isinstance(name,str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}",name):
            raise ValueError("Invalid skill name")
        matches=list((__import__('agentos.paths',fromlist=['SKILLS']).SKILLS).glob(name+"/SKILL.md"))
        if not matches: raise ValueError("Skill not found")
        text=matches[0].read_text(encoding="utf-8",errors="replace")
        if len(text)>100000: raise ValueError("Skill instructions exceed 100 KB")
        return {"ok":True,"name":name,"instructions":text}
    if action=="plugins.call":
        return {"ok":True,"result":call_plugin_tool(args.get("plugin", ""),args.get("tool", ""),args.get("arguments",{}))}
    if action=="workspace.list":
        rel=args.get("path","")
        base=WORKSPACE if not rel else safe_workspace_path(rel)
        if not base.exists(): return {"ok":True,"items":[]}
        if not base.is_dir(): raise ValueError("Path is not a directory")
        items=[]
        for p in sorted(base.iterdir()): items.append({"name":p.name,"type":"directory" if p.is_dir() else "file"})
        return {"ok":True,"items":items}
    if action=="workspace.read_file":
        p=safe_workspace_path(args.get("path"))
        if not p.is_file(): raise ValueError("File does not exist")
        if p.stat().st_size>1024*1024: raise ValueError("File exceeds 1 MB limit")
        return {"ok":True,"path":str(p.relative_to(WORKSPACE)),"content":p.read_text(encoding="utf-8",errors="replace")}
    if action=="workspace.create_file":
        p=safe_workspace_path(args.get("path")); content=args.get("content","")
        if not isinstance(content,str) or len(content)>200000: raise ValueError("Content must be text under 200 KB")
        p.parent.mkdir(parents=True,exist_ok=True)
        if p.exists(): raise ValueError("File already exists; overwrite is not enabled")
        p.write_text(content,encoding="utf-8")
        return {"ok":True,"created":str(p.relative_to(WORKSPACE))}
    raise ValueError("Unsupported action: "+str(action))

def handle(payload):
    if payload.get("protocol")!="agentos.v1": return {"ok":False,"error":"Unsupported protocol"}
    typ=payload.get("type")
    if typ=="PING": return {"ok":True,"type":"PONG","protocol":"agentos.v1"}
    if typ=="runtime.status": return execute("runtime.status",{})
    if typ in ("skills.list","plugins.list","mcp.list"): return execute(typ,{})
    if typ=="action.execute":
        action=payload.get("action"); args=payload.get("arguments",{})
        audit("action.request",{"action":action})
        result=execute(action,args)
        audit("action.success",{"action":action})
        return result
    return {"ok":False,"error":"Unknown message type"}
