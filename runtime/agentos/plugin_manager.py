"""Explicitly trusted Python plugin execution. Plugins run with user permissions."""
import json, importlib.util
from pathlib import Path
from .paths import PLUGINS

def call_plugin_tool(plugin_id, tool_name, arguments):
    if not plugin_id or "/" in plugin_id or "\\" in plugin_id or ".." in plugin_id:
        raise ValueError("Invalid plugin id")
    folder=(PLUGINS/plugin_id).resolve()
    if folder.parent != PLUGINS.resolve(): raise ValueError("Invalid plugin path")
    manifest_path=folder/"plugin.json"
    if not manifest_path.exists(): raise ValueError("Plugin manifest not found")
    manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("enabled") or not manifest.get("trusted"):
        raise PermissionError("Plugin must be explicitly enabled and trusted")
    declared={x.get("name") for x in manifest.get("tools",[]) if isinstance(x,dict)}
    if tool_name not in declared: raise ValueError("Tool is not declared by plugin")
    entry=manifest.get("entrypoint","plugin.py")
    path=(folder/entry).resolve()
    if folder not in path.parents or not path.is_file(): raise ValueError("Invalid plugin entrypoint")
    spec=importlib.util.spec_from_file_location("agentos_plugin_"+plugin_id.replace("-","_"),path)
    if not spec or not spec.loader: raise RuntimeError("Cannot load plugin")
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    fn=getattr(module,tool_name,None)
    if not callable(fn): raise ValueError("Plugin tool function not found")
    if not isinstance(arguments,dict): raise ValueError("Plugin arguments must be an object")
    return fn(**arguments)
