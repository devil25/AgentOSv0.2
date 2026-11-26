import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentos.actions import execute, handle


class FakePipe:
    def __init__(self, chunks=(), unblock_event=None):
        self.chunks = iter(chunks)
        self.unblock_event = unblock_event

    def readline(self):
        try:
            return next(self.chunks)
        except StopIteration:
            if self.unblock_event is not None:
                self.unblock_event.wait(timeout=5)
            return ""


class FakeProcess:
    def __init__(self, stdout=("ok\n",), stderr=(), returncode=0, blocking=False):
        self._returncode = returncode
        self._event = threading.Event()
        event = self._event if blocking else None
        self.stdout = FakePipe(stdout, event)
        self.stderr = FakePipe(stderr, event)

    def poll(self):
        return self._returncode

    def wait(self, timeout=None):
        if self._returncode is None:
            raise subprocess.TimeoutExpired("fake-process", timeout)
        return self._returncode

    def terminate(self):
        self._returncode = -15
        self._event.set()

    def kill(self):
        self._returncode = -9
        self._event.set()


class ActionTests(unittest.TestCase):
    def test_runtime_status(self):
        result = execute("runtime.status", {})
        self.assertTrue(result["ok"])
        self.assertEqual(result["ai_source"], "web")
        self.assertTrue(result["terminal_enabled"])

    def test_unknown_action_is_rejected(self):
        with self.assertRaises(ValueError):
            execute("terminal.run_unlisted", {"command": "whoami"})

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
            with patch("agentos.paths.WORKSPACE", root):
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

    def test_terminal_execute_uses_workspace_as_working_directory(self):
        process = FakeProcess(stdout=("ok\n",))
        with patch("agentos.paths.WORKSPACE", Path(tempfile.gettempdir())):
            with patch("agentos.actions.subprocess.Popen", return_value=process) as popen:
                result = execute("terminal.execute", {"command": "echo ok"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["stdout"], "ok\n")
        self.assertEqual(popen.call_args.kwargs["cwd"], str(Path(tempfile.gettempdir()).resolve()))
        self.assertFalse(popen.call_args.kwargs["shell"])

    def test_terminal_execute_allows_unrestricted_command_text(self):
        process = FakeProcess(stdout=("mocked\n",))
        with patch("agentos.actions.subprocess.Popen", return_value=process) as popen:
            result = execute("terminal.execute", {"command": "format C:"})
        self.assertTrue(result["ok"])
        self.assertEqual(popen.call_args.args[0][-1], "format C:")

    def test_terminal_execute_allows_external_working_directory(self):
        with tempfile.TemporaryDirectory() as workspace:
            with tempfile.TemporaryDirectory() as external:
                process = FakeProcess(stdout=("external\n",))
                with patch("agentos.paths.WORKSPACE", Path(workspace)):
                    with patch("agentos.actions.subprocess.Popen", return_value=process) as popen:
                        result = execute("terminal.execute", {
                            "command": "Get-Location",
                            "cwd": external
                        })
                self.assertTrue(result["ok"])
                self.assertEqual(popen.call_args.kwargs["cwd"], str(Path(external).resolve()))
                self.assertEqual(result["cwd"], str(Path(external).resolve()))

    def test_terminal_execute_rejects_nonexistent_working_directory(self):
        with tempfile.TemporaryDirectory() as workspace:
            missing = str(Path(workspace) / "does-not-exist")
            with patch("agentos.paths.WORKSPACE", Path(workspace)):
                with self.assertRaisesRegex(ValueError, "existing directory"):
                    execute("terminal.execute", {"command": "Get-Location", "cwd": missing})

    def test_terminal_execute_streams_stdout_and_stderr_events(self):
        process = FakeProcess(stdout=("first line\n",), stderr=("warning line\n",))
        events = []
        with patch("agentos.actions.subprocess.Popen", return_value=process):
            result = execute("terminal.execute", {"command": "Write-Output test"}, emit=events.append)
        self.assertTrue(result["ok"])
        self.assertEqual(result["stdout"], "first line\n")
        self.assertEqual(result["stderr"], "warning line\n")
        self.assertEqual(events[0]["type"], "terminal.started")
        self.assertIn("terminal.output", [event["type"] for event in events])
        self.assertEqual(events[-1]["type"], "terminal.finished")
        self.assertEqual(events[-1]["returncode"], 0)

    def test_terminal_output_events_are_chunked_for_native_messaging(self):
        process = FakeProcess(stdout=("x" * 9500,))
        events = []
        with patch("agentos.actions.subprocess.Popen", return_value=process):
            result = execute("terminal.execute", {"command": "Write-Output test"}, emit=events.append)
        chunks = [event["text"] for event in events if event["type"] == "terminal.output"]
        self.assertTrue(result["ok"])
        self.assertGreaterEqual(len(chunks), 3)
        self.assertLessEqual(max(map(len, chunks)), 4000)
        self.assertEqual("".join(chunks), "x" * 9500)

    def test_native_action_handler_forwards_terminal_events(self):
        process = FakeProcess(stdout=("native host stream\\n",))
        events = []
        payload = {
            "protocol": "agentos.v1",
            "type": "action.execute",
            "action": "terminal.execute",
            "arguments": {"command": "Write-Output test"},
        }
        with patch("agentos.actions.subprocess.Popen", return_value=process):
            result = handle(payload, emit=events.append)
        self.assertTrue(result["ok"])
        self.assertEqual(events[0]["type"], "terminal.started")
        self.assertEqual(events[-1]["type"], "terminal.finished")
        self.assertIn("terminal.output", [event["type"] for event in events])

    def test_terminal_execute_returns_partial_output_on_timeout(self):
        process = FakeProcess(
            stdout=("partial stdout\n",),
            stderr=("partial stderr\n",),
            returncode=None,
            blocking=True,
        )
        with patch("agentos.actions.subprocess.Popen", return_value=process):
            result = execute("terminal.execute", {
                "command": "Start-Sleep -Seconds 10",
                "timeout_seconds": 1
            })
        self.assertFalse(result["ok"])
        self.assertTrue(result["timed_out"])
        self.assertIsNone(result["returncode"])
        self.assertEqual(result["stdout"], "partial stdout\n")
        self.assertEqual(result["stderr"], "partial stderr\n")

    def test_terminal_execute_accepts_timeout_up_to_600_seconds(self):
        process = FakeProcess(stdout=("ok\n",))
        with patch("agentos.actions.subprocess.Popen", return_value=process):
            result = execute("terminal.execute", {
                "command": "Get-Date",
                "timeout_seconds": 600
            })
        self.assertTrue(result["ok"])

    def test_terminal_execute_rejects_invalid_timeout(self):
        with self.assertRaises(ValueError):
            execute("terminal.execute", {"command": "echo ok", "timeout_seconds": 601})

    def test_invalid_tool_arguments_are_rejected(self):
        with self.assertRaises(ValueError):
            execute("mcp.call", {"server": "demo", "tool": "echo", "arguments": []})

    def test_missing_required_argument_is_rejected(self):
        with self.assertRaises(ValueError):
            execute("mcp.tools", {})


if __name__ == "__main__":
    unittest.main()
