import re
import os
import subprocess
from pathlib import Path
from . import paths as agent_paths
from .paths import safe_workspace_path, SKILLS
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
    "terminal.execute",
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
    # Use POSIX separators in returned paths on every operating system.
    # Resolve both sides to avoid Windows short-name/case differences.
    return path.resolve().relative_to(agent_paths.WORKSPACE.resolve()).as_posix()

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
            "autonomy": "configurable",
            "terminal_enabled": True,
            "workspace": str(agent_paths.WORKSPACE.resolve()),
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
        base = agent_paths.WORKSPACE if not rel else safe_workspace_path(rel)
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

    if action == "terminal.execute":
        command = _required_text(args, "command", 100000)
        timeout = args.get("timeout_seconds", 120)
        if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 600:
            raise ValueError("'timeout_seconds' must be an integer from 1 to 600")

        requested_cwd = args.get("cwd")
        if requested_cwd is None or requested_cwd == "":
            working_directory = agent_paths.WORKSPACE.resolve()
        else:
            if not isinstance(requested_cwd, str) or not requested_cwd.strip() or len(requested_cwd) > 1024:
                raise ValueError("'cwd' must be a non-empty directory path under 1024 characters")
            requested_path = Path(requested_cwd).expanduser()
            if not requested_path.is_absolute():
                requested_path = agent_paths.WORKSPACE / requested_path
            working_directory = requested_path.resolve()
            if not working_directory.exists() or not working_directory.is_dir():
                raise ValueError("'cwd' must point to an existing directory")

        if os.name == "nt":
            argv = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
        else:
            argv = ["/bin/bash", "-lc", command]

        try:
            completed = subprocess.run(
                argv,
                cwd=str(working_directory),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            def partial_text(value):
                if value is None:
                    return ""
                if isinstance(value, bytes):
                    return value.decode("utf-8", "replace")[-60000:]
                return str(value)[-60000:]

            return {
                "ok": False,
                "timed_out": True,
                "returncode": None,
                "timeout_seconds": timeout,
                "cwd": str(working_directory),
                "stdout": partial_text(exc.stdout),
                "stderr": partial_text(exc.stderr),
                "command": command,
                "execution_scope": "current operating-system user permissions; no workspace sandbox",
            }

        stdout = completed.stdout[-60000:]
        stderr = completed.stderr[-60000:]
        return {
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            "cwd": str(working_directory),
            "stdout": stdout,
            "stderr": stderr,
            "command": command,
            "execution_scope": "current operating-system user permissions; no workspace sandbox",
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
    if typ == "workspace.get":
        return {"ok": True, "path": str(agent_paths.WORKSPACE.resolve())}
    if typ == "workspace.select_directory":
        from .workspace_picker import choose_directory
        selected = choose_directory()
        if not selected:
            return {"ok": True, "cancelled": True, "path": str(agent_paths.WORKSPACE.resolve())}
        workspace = agent_paths.set_workspace(selected)
        audit("workspace.changed", {"path": str(workspace)})
        return {"ok": True, "path": str(workspace)}
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
