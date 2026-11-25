$ErrorActionPreference='Stop'
$RegPath='HKCU:\Software\Mozilla\NativeMessagingHosts\com.agentos.host'
if (Test-Path $RegPath) { Remove-Item $RegPath -Recurse -Force }
Write-Host 'AgentOS Native Messaging Host registration removed.' -ForegroundColor Green
