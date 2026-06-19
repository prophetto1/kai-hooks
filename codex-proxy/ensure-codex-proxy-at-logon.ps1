param(
    [string]$EnsureScript = "E:\hooks\codex-proxy\ensure-codex-proxy.ps1",
    [int]$WaitSeconds = 120
)

$ErrorActionPreference = "Stop"

$logDir = Join-Path $env:LOCALAPPDATA "JWC\codex-proxy"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "startup-task.log"

function Write-StartupLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString("o")
    Add-Content -LiteralPath $logPath -Value "$stamp $Message"
}

try {
    Write-StartupLog "JWC-Codex-Proxy-8787 startup wrapper begin. ensure=$EnsureScript"

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while (-not (Test-Path -LiteralPath $EnsureScript)) {
        if ((Get-Date) -ge $deadline) {
            throw "Ensure script not available after ${WaitSeconds}s: $EnsureScript"
        }
        Start-Sleep -Seconds 2
    }

    & $EnsureScript
    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
        throw "ensure-codex-proxy.ps1 exited with code $LASTEXITCODE"
    }

    Write-StartupLog "JWC-Codex-Proxy-8787 startup wrapper complete."
}
catch {
    Write-StartupLog "JWC-Codex-Proxy-8787 startup wrapper failed: $($_.Exception.Message)"
    throw
}
