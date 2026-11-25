import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentos.actions import execute, handle


class ActionTests(unittest.TestCase):
    def test_runtime_status(self):
        result = execute("runtime.status", {})
        self.assertTrue(result["ok"])
        self.assertEqual(result["ai_source"], "web")
        self.assertFalse(result["terminal_enabled"])

    def test_unknown_action_is_rejected(self):
        with self.assertRaises(ValueError):
            execute("terminal.execute", {"command": "whoami"})

    def test_path_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            execute("workspace.read_file", {"path": "../../Windows/win.ini"})

    def test_handle_requires_protocol(self):
        result = handle({"type": "runtime.status"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Unsupported protocol")

    def test_ping(self):
        result = handle({"protocol": "agentos.v1", "type": "PING"})
        self.assertEqual(result["type"], "PONG")

    def test_create_read_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch("agentos.actions.WORKSPACE", root), patch("agentos.paths.WORKSPACE", root):
                created = execute(
                    "workspace.create_file",
                    {"path": "notes/summary.md", "content": "AgentOS test"},
                )
                self.assertEqual(created["created"], "notes/summary.md")
                read = execute("workspace.read_file", {"path": "notes/summary.md"})
                self.assertEqual(read["content"], "AgentOS test")
                with self.assertRaises(FileExistsError):
                    execute(
                        "workspace.create_file",
                        {"path": "notes/summary.md", "content": "overwrite"},
                    )

    def test_invalid_tool_arguments_are_rejected(self):
        with self.assertRaises(ValueError):
            execute("mcp.call", {"server": "demo", "tool": "echo", "arguments": []})

    def test_missing_required_argument_is_rejected(self):
        with self.assertRaises(ValueError):
            execute("mcp.tools", {})


if __name__ == "__main__":
    unittest.main()
