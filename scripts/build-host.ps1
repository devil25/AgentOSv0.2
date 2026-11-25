$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (-not (Test-Path '.venv\Scripts\python.exe')) { python -m venv .venv }
& '.\.venv\Scripts\python.exe' -m pip install --upgrade pip pyinstaller
& '.\.venv\Scripts\pyinstaller.exe' --noconfirm --clean --onefile --name AgentOSHost --paths runtime --distpath build runtime\agentos\native_host.py
if (-not (Test-Path 'build\AgentOSHost.exe')) { throw 'Build failed: AgentOSHost.exe was not created.' }
Write-Host "Built: $Root\build\AgentOSHost.exe" -ForegroundColor Green
