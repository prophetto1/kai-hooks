param(
    [string]$TaskName = "JWC-Hindsight-10003",
    [string]$EnsureScript = "E:\hooks\hindsight\ensure-hindsight.ps1",
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $EnsureScript)) {
    throw "Ensure script not found: $EnsureScript"
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$EnsureScript`""

$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited

$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Ensures native Hindsight MCP API is available on 127.0.0.1:10003 after user logon."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,TaskPath,State
