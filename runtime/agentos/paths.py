from pathlib import Path
import json
import os
import sys
import tempfile

if getattr(sys, "frozen", False):
    ROOT = Path(sys.executable).resolve().parent.parent
else:
    ROOT = Path(__file__).resolve().parents[2]

SKILLS = ROOT / "skills"
PLUGINS = ROOT / "plugins"
CONFIG = ROOT / "config"
LOGS = ROOT / "logs"
WORKSPACE_CONFIG = CONFIG / "workspace.json"
DEFAULT_WORKSPACE = ROOT / "workspace"

for folder in (DEFAULT_WORKSPACE, SKILLS, PLUGINS, CONFIG, LOGS):
    folder.mkdir(parents=True, exist_ok=True)


def _load_workspace():
    try:
        data = json.loads(WORKSPACE_CONFIG.read_text(encoding="utf-8"))
        configured = data.get("path") if isinstance(data, dict) else None
        if isinstance(configured, str) and configured.strip():
            candidate = Path(configured).expanduser().resolve()
            if candidate.is_dir():
                return candidate
    except (OSError, ValueError, TypeError):
        pass
    return DEFAULT_WORKSPACE.resolve()


WORKSPACE = _load_workspace()


def set_workspace(path: str) -> Path:
    """Persist an explicitly selected existing directory as the AgentOS workspace."""
    global WORKSPACE
    if not isinstance(path, str) or not path.strip():
        raise ValueError("A workspace directory is required")
    candidate = Path(path).expanduser().resolve()
    if not candidate.exists() or not candidate.is_dir():
        raise ValueError("The selected workspace must be an existing directory")
    CONFIG.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"path": str(candidate)}, ensure_ascii=False, indent=2) + "\\n"
    fd, temporary = tempfile.mkstemp(prefix="workspace-", suffix=".tmp", dir=str(CONFIG))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(payload)
        os.replace(temporary, WORKSPACE_CONFIG)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass
    WORKSPACE = candidate
    return WORKSPACE


def get_workspace() -> Path:
    return WORKSPACE


def safe_workspace_path(relative: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("A relative workspace path is required")
    candidate = (WORKSPACE / relative).resolve()
    base = WORKSPACE.resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        raise ValueError("Path escapes AgentOS workspace")
    if candidate == base:
        raise ValueError("Workspace root itself is not a file")
    return candidate
