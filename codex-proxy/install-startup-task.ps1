param(
    [string]$TaskName = "JWC-Codex-Proxy-8787",
    [string]$LegacyWatchdogTaskName = "JWC-Codex-Proxy-8787-Watchdog",
    [string]$EnsureScript = (Join-Path $PSScriptRoot "ensure-codex-proxy.ps1"),
    [string]$SourceWrapper = (Join-Path $PSScriptRoot "ensure-codex-proxy-at-logon.ps1"),
    [string]$TaskScript = (Join-Path $env:LOCALAPPDATA "JWC\startup\ensure-codex-proxy-at-logon.ps1"),
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SourceWrapper)) {
    throw "Startup wrapper not found: $SourceWrapper"
}
if (-not (Test-Path -LiteralPath $EnsureScript)) {
    throw "Ensure script not found: $EnsureScript"
}

$taskScriptDir = Split-Path -Parent $TaskScript
New-Item -ItemType Directory -Force -Path $taskScriptDir | Out-Null
Copy-Item -LiteralPath $SourceWrapper -Destination $TaskScript -Force

# Remove the old 5-minute watchdog — it flashed a console window and is not needed.
Unregister-ScheduledTask -TaskName $LegacyWatchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-WindowStyle Hidden -NonInteractive -NoProfile -ExecutionPolicy Bypass -File `"$TaskScript`""

$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $argument -WorkingDirectory $taskScriptDir
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited

$task = New-ScheduledTask `
    -Action $action `
    -Trigger $logonTrigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Silently ensures Codex subscription proxy listens on 127.0.0.1:8787 after user logon."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    & $EnsureScript
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, TaskPath, State
