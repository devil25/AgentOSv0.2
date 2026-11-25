from pathlib import Path
import sys

if getattr(sys, "frozen", False):
    ROOT = Path(sys.executable).resolve().parent.parent
else:
    ROOT = Path(__file__).resolve().parents[2]

WORKSPACE = ROOT / "workspace"
SKILLS = ROOT / "skills"
PLUGINS = ROOT / "plugins"
CONFIG = ROOT / "config"
LOGS = ROOT / "logs"

for p in (WORKSPACE, SKILLS, PLUGINS, CONFIG, LOGS):
    p.mkdir(parents=True, exist_ok=True)

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
