import re
from .paths import safe_workspace_path, WORKSPACE, SKILLS
from .catalog import list_skills, list_plugins, list_mcp
from .audit import audit
from .mcp_client import list_tools as mcp_list_tools, call_tool as mcp_call_tool
from .plugin_manager import call_plugin_tool

VERSION = "0.2.0-rc1"

SUPPORTED_ACTIONS = {
    "runtime.status",
    "skills.list",
    "plugins.list",
    "mcp.list",
    "mcp.tools",
    "mcp.call",
    "skills.read",
    "plugins.call",
    "workspace.list",
    "workspace.read_file",
    "workspace.create_file",
}


def _required_text(args, key, max_length=256):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise ValueError(f"'{key}' must be a non-empty string under {max_length} characters")
    return value.strip()


def _optional_path(args):
    value = args.get("path", "")
    if not isinstance(value, str) or len(value) > 1024:
        raise ValueError("'path' must be text under 1024 characters")
    return value


def _workspace_relative(path):
    # Resolve both sides to avoid Windows short-name/case differences.
    return str(path.resolve().relative_to(WORKSPACE.resolve()))


def execute(action, args):
    if not isinstance(action, str) or action not in SUPPORTED_ACTIONS:
        raise ValueError("Unsupported action: " + str(action))
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")

    if action == "runtime.status":
        return {
            "ok": True,
            "version": VERSION,
            "runtime": "online",
            "ai_source": "web",
            "autonomy": "hybrid",
            "terminal_enabled": False,
        }

    if action == "skills.list":
        return {"ok": True, "items": list_skills()}

    if action == "plugins.list":
        return {"ok": True, "items": list_plugins()}

    if action == "mcp.list":
        return {"ok": True, "items": list_mcp()}

    if action == "mcp.tools":
        server = _required_text(args, "server")
        return {"ok": True, "items": mcp_list_tools(server)}

    if action == "mcp.call":
        server = _required_text(args, "server")
        tool = _required_text(args, "tool")
        tool_args = args.get("arguments", {})
        if not isinstance(tool_args, dict):
            raise ValueError("'arguments' for mcp.call must be an object")
        return {"ok": True, "result": mcp_call_tool(server, tool, tool_args)}

    if action == "skills.read":
        name = _required_text(args, "name", 64)
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
            raise ValueError("Invalid skill name")
        skill_file = SKILLS / name / "SKILL.md"
        if not skill_file.is_file():
            raise ValueError("Skill not found")
        text = skill_file.read_text(encoding="utf-8", errors="replace")
        if len(text) > 100000:
            raise ValueError("Skill instructions exceed 100 KB")
        return {"ok": True, "name": name, "instructions": text}

    if action == "plugins.call":
        plugin = _required_text(args, "plugin")
        tool = _required_text(args, "tool")
        tool_args = args.get("arguments", {})
        if not isinstance(tool_args, dict):
            raise ValueError("'arguments' for plugins.call must be an object")
        return {"ok": True, "result": call_plugin_tool(plugin, tool, tool_args)}

    if action == "workspace.list":
        rel = _optional_path(args)
        base = WORKSPACE if not rel else safe_workspace_path(rel)
        if not base.exists():
            return {"ok": True, "items": []}
        if not base.is_dir():
            raise ValueError("Path is not a directory")
        items = [
            {"name": p.name, "type": "directory" if p.is_dir() else "file"}
            for p in sorted(base.iterdir(), key=lambda item: item.name.lower())
        ]
        return {"ok": True, "items": items}

    if action == "workspace.read_file":
        p = safe_workspace_path(_required_text(args, "path", 1024))
        if not p.is_file():
            raise ValueError("File does not exist")
        if p.stat().st_size > 1024 * 1024:
            raise ValueError("File exceeds 1 MB limit")
        return {
            "ok": True,
            "path": _workspace_relative(p),
            "content": p.read_text(encoding="utf-8", errors="replace"),
        }

    if action == "workspace.create_file":
        p = safe_workspace_path(_required_text(args, "path", 1024))
        content = args.get("content", "")
        if not isinstance(content, str) or len(content) > 200000:
            raise ValueError("Content must be text under 200 KB")
        p.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation avoids overwriting an existing file.
        with p.open("x", encoding="utf-8", newline="") as stream:
            stream.write(content)
        return {"ok": True, "created": _workspace_relative(p)}

    raise ValueError("Unsupported action: " + str(action))


def handle(payload):
    if not isinstance(payload, dict) or payload.get("protocol") != "agentos.v1":
        return {"ok": False, "error": "Unsupported protocol"}

    typ = payload.get("type")
    if typ == "PING":
        return {"ok": True, "type": "PONG", "protocol": "agentos.v1"}
    if typ == "runtime.status":
        return execute("runtime.status", {})
    if typ in ("skills.list", "plugins.list", "mcp.list"):
        return execute(typ, {})
    if typ == "action.execute":
        action = payload.get("action")
        args = payload.get("arguments", {})
        audit("action.request", {"action": action})
        result = execute(action, args)
        audit("action.success", {"action": action})
        return result
    return {"ok": False, "error": "Unknown message type"}
