# AgentOS v0.2.0-dev — Windows + Firefox

AgentOS is a supervised browser-agent project. The AI model runs in a supported website tab; AgentOS connects that website to a local Windows runtime and a controlled set of tools. This project does **not** use model APIs or local LLMs.

## v0.2 development direction

- **AI source:** web UI only; Z.ai is the primary provider, followed by ChatGPT, Claude, and Gemini.
- **Autonomy:** hybrid and supervised. Reading provider output is separate from executing an action. The user must approve submitting a task to the AI website and review actions before execution.
- **Browser integration:** DOM-based adapters. Website markup can change, so selectors require maintenance and site-specific testing.
- **Tools:** existing local workspace, Skills, Plugins, and configured MCP tools. No arbitrary PowerShell or shell execution.
- **Safety:** workspace file access stays restricted to the AgentOS workspace. MCP and Python plugins run with the Windows user's permissions; only configure code you trust.

## Current v0.2 development features

- Firefox sidebar now detects Z.ai, ChatGPT, Claude, and Gemini tabs.
- The sidebar can fill a task into the active AI website and asks before submitting it.
- It can read detected assistant messages and offer a fenced JSON action for manual review.
- It asks for confirmation before running a proposed action.
- Z.ai support is included for `https://chat.z.ai/` and is not limited to one conversation URL.
- The corrected `.gitignore` excludes local logs, backups, private MCP config, and Native Messaging runtime config.

**Important:** this is an early development build, not a finished autonomous agent. It does not yet have a persistent planner/execution/evaluation loop. Provider DOM selectors are heuristic and may need adjustment after testing against the live websites. AI-generated actions are untrusted input and must be reviewed.

## Requirements

- Windows 10/11 64-bit
- Firefox 128 or newer
- Python 3.11+
- Git
- Optional: dependencies listed in `requirements-mcp.txt` for the demo MCP server

## Development install

Use the project directory where you cloned or extracted AgentOS. In this user's current setup it is:

```powershell
cd D:\AgentOS-v0.1.0-Windows\AgentOS
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup.ps1
```

Load `extension\manifest.json` temporarily from `about:debugging#/runtime/this-firefox`.

Build and register the Native Messaging host:

```powershell
.\scripts\build-host.ps1
.\scripts\install-host.ps1
```

Restart/reload the extension and test the Windows runtime from the sidebar.

## Run tests

```powershell
.\.venv\Scripts\Activate.ps1
python -m unittest discover -s runtime\tests -v
```

## Configuration

- Copy `config\mcp_servers.example.json` to `config\mcp_servers.json` and configure only reviewed local MCP servers.
- `config\mcp_servers.json` is intentionally ignored by Git.
- `runtime\com.agentos.host.json` is generated locally by the host installer and is intentionally ignored.
- Do not commit API keys, passwords, tokens, or private configuration.

## Supported action envelope

```json
{
  "protocol": "agentos.v1",
  "type": "action",
  "action": "workspace.create_file",
  "arguments": {
    "path": "notes/hello.txt",
    "content": "Hello from AgentOS"
  }
}
```

## Security notes

- Workspace paths are resolved and checked to prevent path traversal.
- File writes create new files only; overwrite is not enabled.
- No general-purpose terminal execution is implemented.
- MCP servers and Python plugins execute with the current Windows user's permissions. They are not sandboxed by AgentOS.
- Do not enable third-party plugins or MCP servers before reviewing their source and commands.
- Browser automation can interact with logged-in sessions. Keep explicit confirmation for any action that sends, publishes, deletes, purchases, or changes account data.

## Planned milestones

1. Stabilize provider adapters and verify selectors on each supported website.
2. Add structured task plans and a durable execution state machine.
3. Add policy checks, per-tool approval, cancellation, and audit records.
4. Add result evaluation and bounded continuation with loop/time limits.
5. Expand automated tests and package a reproducible Windows release.
