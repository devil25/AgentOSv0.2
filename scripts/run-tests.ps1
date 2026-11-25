$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (-not (Test-Path '.venv\Scripts\python.exe')) { py -3 -m venv .venv }
& '.\.venv\Scripts\python.exe' -m unittest discover -s runtime\tests -v
