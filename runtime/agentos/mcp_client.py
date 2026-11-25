"""Minimal MCP stdio client for explicitly configured and enabled servers.

MCP server processes inherit the current Windows user's permissions. Only
configure servers and allow tool names that have been reviewed and trusted.
"""
import json
import queue
import subprocess
import threading
from .paths import CONFIG

MAX_LINE_CHARS = 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 20


class MCPError(RuntimeError):
    pass


def _server(name):
    if not isinstance(name, str) or not name.strip() or len(name) > 128:
        raise MCPError("Invalid MCP server name")

    config_file = CONFIG / "mcp_servers.json"
    if not config_file.is_file():
        raise MCPError("mcp_servers.json not configured")

    data = json.loads(config_file.read_text(encoding="utf-8"))
    servers = data.get("servers", {})
    cfg = servers.get(name) if isinstance(servers, dict) else None
    if not isinstance(cfg, dict):
        raise MCPError("Unknown MCP server")
    if not cfg.get("enabled", False):
        raise MCPError("MCP server is disabled")

    command = cfg.get("command")
    args = cfg.get("args", [])
    if not isinstance(command, str) or not command.strip():
        raise MCPError("Invalid server command")
    if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
        raise MCPError("Invalid server args")
    allowed = cfg.get("allowed_tools", [])
    if not isinstance(allowed, list) or not all(isinstance(item, str) for item in allowed):
        raise MCPError("Invalid allowed_tools configuration")
    return cfg, command, args


class _Session:
    def __init__(self, process):
        self.process = process
        self.responses = queue.Queue()
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader.start()

    def _read_stdout(self):
        try:
            for line in self.process.stdout:
                if len(line) > MAX_LINE_CHARS:
                    continue
                try:
                    message = json.loads(line)
                except (json.JSONDecodeError, TypeError):
                    # Ignore non-JSON diagnostic lines; MCP servers must send
                    # protocol messages on stdout and diagnostics on stderr.
                    continue
                if isinstance(message, dict) and "id" in message:
                    self.responses.put(message)
        except Exception as exc:
            self.responses.put({"_reader_error": str(exc)})

    def request(self, message, timeout=REQUEST_TIMEOUT_SECONDS):
        if self.process.poll() is not None:
            raise MCPError("MCP server process has exited")
        try:
            encoded = json.dumps(message, ensure_ascii=False)
            if len(encoded) > MAX_LINE_CHARS:
                raise MCPError("MCP request exceeds the message size limit")
            self.process.stdin.write(encoded + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise MCPError(f"Could not write to MCP server: {exc}") from exc

        request_id = message.get("id")
        while True:
            try:
                response = self.responses.get(timeout=timeout)
            except queue.Empty as exc:
                raise MCPError(f"MCP request timed out after {timeout} seconds") from exc
            if response.get("_reader_error"):
                raise MCPError("MCP response reader failed: " + response["_reader_error"])
            if response.get("id") != request_id:
                continue
            if "error" in response:
                raise MCPError(str(response["error"]))
            return response.get("result", {})


def _connect(name):
    cfg, command, args = _server(name)
    try:
        process = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        raise MCPError(f"Could not start MCP server: {exc}") from exc

    session = _Session(process)
    try:
        result = session.request({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "AgentOS", "version": "0.2.0-rc1"},
            },
        })
        if not isinstance(result, dict):
            raise MCPError("MCP initialize returned an invalid result")
        process.stdin.write(json.dumps({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        }) + "\n")
        process.stdin.flush()
        return session, cfg
    except Exception:
        _stop(session)
        raise


def _stop(session):
    process = session.process
    try:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=2)
    except Exception:
        try:
            process.kill()
            process.wait(timeout=2)
        except Exception:
            pass
    for stream in (process.stdin, process.stdout):
        try:
            if stream:
                stream.close()
        except Exception:
            pass


def list_tools(name):
    session, cfg = _connect(name)
    try:
        result = session.request({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        })
        tools = result.get("tools", []) if isinstance(result, dict) else []
        if not isinstance(tools, list):
            raise MCPError("MCP tools/list returned an invalid result")
        allowed = set(cfg.get("allowed_tools", []))
        return [
            {
                "name": tool.get("name"),
                "description": tool.get("description", ""),
                "allowed": tool.get("name") in allowed,
                "inputSchema": tool.get("inputSchema", {}),
            }
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)
        ]
    finally:
        _stop(session)


def call_tool(name, tool, arguments):
    if not isinstance(tool, str) or not tool.strip():
        raise MCPError("A tool name is required")
    if not isinstance(arguments, dict):
        raise MCPError("Tool arguments must be an object")

    session, cfg = _connect(name)
    try:
        allowed = set(cfg.get("allowed_tools", []))
        if tool not in allowed:
            raise MCPError("Tool is not in allowed_tools")
        return session.request({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        })
    finally:
        _stop(session)
