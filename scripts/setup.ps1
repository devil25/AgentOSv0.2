$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$PyVersion = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ([version]$PyVersion -lt [version]'3.11') { throw 'Python 3.11 or newer is required.' }
New-Item -ItemType Directory -Force -Path 'workspace','skills','plugins','config','logs' | Out-Null
if (-not (Test-Path 'config\mcp_servers.json')) { Copy-Item 'config\mcp_servers.example.json' 'config\mcp_servers.json' }
if (-not (Test-Path '.venv')) { python -m venv .venv }
& '.\.venv\Scripts\python.exe' -m pip install --upgrade pip
Write-Host "AgentOS folders and Python environment are ready." -ForegroundColor Green
Write-Host "Next: .\scripts\build-host.ps1, then .\scripts\install-host.ps1" -ForegroundColor Cyan
