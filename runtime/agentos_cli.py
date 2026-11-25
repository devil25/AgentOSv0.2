import argparse, json, subprocess, sys, shutil, tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from agentos.catalog import list_skills,list_plugins,list_mcp
from agentos.paths import SKILLS,PLUGINS

def install_github(repo, destination):
    url=repo if repo.startswith(("https://","http://","git@")) else "https://github.com/"+repo.removesuffix(".git")+".git"
    with tempfile.TemporaryDirectory(prefix="agentos-import-") as td:
        clone=Path(td)/"repo"
        subprocess.run(["git","clone","--depth","1",url,str(clone)],check=True)
        if destination=="skills":
            found=list(clone.rglob("SKILL.md"))
            if not found: raise SystemExit("No SKILL.md found in repository")
            for skill in found:
                name=skill.parent.name; target=SKILLS/name
                if target.exists(): print("Skipped existing skill:",name); continue
                shutil.copytree(skill.parent,target,ignore=shutil.ignore_patterns(".git")); print("Imported skill:",name)
        else:
            manifests=list(clone.rglob("plugin.json"))
            if not manifests: raise SystemExit("No plugin.json found in repository")
            for mf in manifests:
                folder=mf.parent; pid=folder.name; target=PLUGINS/pid
                if target.exists(): print("Skipped existing plugin:",pid); continue
                shutil.copytree(folder,target,ignore=shutil.ignore_patterns(".git","__pycache__")); print("Imported plugin for review:",pid)

def edit_plugin(pid, field, value):
    if not pid or "/" in pid or "\\" in pid or ".." in pid: raise SystemExit("Invalid plugin id")
    f=PLUGINS/pid/"plugin.json"
    if not f.exists(): raise SystemExit("Plugin not found")
    d=json.loads(f.read_text(encoding="utf-8")); d[field]=value
    f.write_text(json.dumps(d,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    print(field,"updated for",pid)

def main():
    p=argparse.ArgumentParser(prog="agentos"); sub=p.add_subparsers(dest="group",required=True)
    s=sub.add_parser("skills"); ss=s.add_subparsers(dest="cmd",required=True); ss.add_parser("list"); si=ss.add_parser("install-github"); si.add_argument("repo")
    pl=sub.add_parser("plugins"); pls=pl.add_subparsers(dest="cmd",required=True); pls.add_parser("list"); pi=pls.add_parser("inspect"); pi.add_argument("id"); pin=pls.add_parser("install-github"); pin.add_argument("repo"); pe=pls.add_parser("enable"); pe.add_argument("id"); pt=pls.add_parser("trust"); pt.add_argument("id")
    m=sub.add_parser("mcp"); ms=m.add_subparsers(dest="cmd",required=True); ms.add_parser("list"); mt=ms.add_parser("tools"); mt.add_argument("server")
    a=p.parse_args()
    if a.group=="skills":
        if a.cmd=="list": print(json.dumps(list_skills(),indent=2,ensure_ascii=False))
        else: install_github(a.repo,"skills")
    elif a.group=="plugins":
        if a.cmd=="list": print(json.dumps(list_plugins(),indent=2,ensure_ascii=False))
        elif a.cmd=="inspect":
            f=PLUGINS/a.id/"plugin.json"
            if not f.exists(): raise SystemExit("Plugin not found")
            print(f.read_text(encoding="utf-8"))
        elif a.cmd=="install-github": install_github(a.repo,"plugins")
        elif a.cmd=="enable": edit_plugin(a.id,"enabled",True)
        elif a.cmd=="trust": edit_plugin(a.id,"trusted",True)
    elif a.group=="mcp":
        if a.cmd=="list": print(json.dumps(list_mcp(),indent=2,ensure_ascii=False))
        else:
            from agentos.mcp_client import list_tools
            print(json.dumps(list_tools(a.server),indent=2,ensure_ascii=False))
if __name__=="__main__": main()
