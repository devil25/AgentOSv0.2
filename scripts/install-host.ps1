$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Exe=Join-Path $Root 'build\AgentOSHost.exe'
if (-not (Test-Path $Exe)) { throw 'Build the host first: .\scripts\build-host.ps1' }
$ManifestPath=Join-Path $Root 'runtime\com.agentos.host.json'
$Manifest=@{
  name='com.agentos.host'
  description='AgentOS Windows Native Messaging Host'
  path=$Exe
  type='stdio'
  allowed_extensions=@('agentos@example.local')
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($ManifestPath, $Manifest, [System.Text.UTF8Encoding]::new($false))
$RegPath='HKCU:\Software\Mozilla\NativeMessagingHosts\com.agentos.host'
New-Item -Path $RegPath -Force | Out-Null
Set-Item -Path $RegPath -Value $ManifestPath
Write-Host 'AgentOS Native Messaging Host registered for the current Windows user.' -ForegroundColor Green
Write-Host "Manifest: $ManifestPath"
Write-Host 'Restart Firefox, reload AgentOS, then test the connection.'
