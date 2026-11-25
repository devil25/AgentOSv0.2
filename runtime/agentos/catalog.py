import json
from pathlib import Path
from .paths import SKILLS, PLUGINS, CONFIG

def list_skills():
    items=[]
    for f in SKILLS.rglob("SKILL.md"):
        try:
            text=f.read_text(encoding="utf-8",errors="replace")
            name=f.parent.name; desc=""
            if text.startswith("---"):
                parts=text.split("---",2)
                if len(parts)>2:
                    for line in parts[1].splitlines():
                        if line.strip().startswith("name:"): name=line.split(":",1)[1].strip().strip("\"'")
                        if line.strip().startswith("description:"): desc=line.split(":",1)[1].strip().strip("\"'")
            items.append({"name":name,"description":desc[:240],"path":str(f)})
        except OSError: pass
    return items

def list_plugins():
    items=[]
    for f in PLUGINS.glob("*/plugin.json"):
        try:
            d=json.loads(f.read_text(encoding="utf-8"))
            items.append({"id":d.get("id",f.parent.name),"name":d.get("name",f.parent.name),"description":d.get("description",""),"enabled":bool(d.get("enabled",False)),"trusted":bool(d.get("trusted",False))})
        except Exception as e: items.append({"id":f.parent.name,"name":f.parent.name,"description":"Invalid manifest: "+str(e)})
    return items

def list_mcp():
    f=CONFIG/"mcp_servers.json"
    if not f.exists(): return []
    try:
        d=json.loads(f.read_text(encoding="utf-8"))
        return [{"name":n,"description":(v.get("description") or "Local MCP server")+ (" · enabled" if v.get("enabled") else " · disabled"),"enabled":bool(v.get("enabled"))} for n,v in d.get("servers",{}).items()]
    except Exception as e: return [{"name":"Configuration error","description":str(e)}]
