param(
    [string]$HostAddress = "127.0.0.1",
    [int]$Port = 8787,
    [string]$AuthFile = "$env:USERPROFILE\.codex\auth.json",
    [string]$RequiredModel = "gpt-5.3-codex-spark",
    [int]$WaitSeconds = 60,
    [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Output "[codex-proxy] $Message"
}

function Get-ProxyHealth {
    param([string]$BaseUrl, [int]$TimeoutSec = 5)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/health" -TimeoutSec $TimeoutSec
        if ($response.StatusCode -ne 200) {
            return [pscustomobject]@{ Ok = $false; Error = "health status $($response.StatusCode)"; Spark = $false }
        }
        $modelsResponse = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/v1/models" -TimeoutSec $TimeoutSec
        $parsed = $modelsResponse.Content | ConvertFrom-Json
        $ids = @($parsed.data | ForEach-Object { $_.id })
        $hasSpark = $ids -contains $RequiredModel
        return [pscustomobject]@{
            Ok = $true
            Error = $null
            Spark = $hasSpark
            Models = ($ids -join ", ")
        }
    } catch {
        return [pscustomobject]@{ Ok = $false; Error = $_.Exception.Message; Spark = $false; Models = "" }
    }
}

function Stop-ProxyOnPort {
    param([int]$ListenPort)
    $connections = Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue
    foreach ($connection in @($connections)) {
        $processId = $connection.OwningProcess
        if ($processId -and $processId -gt 0) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

$baseUrl = "http://${HostAddress}:$Port"
$logDir = Join-Path $env:LOCALAPPDATA "JWC\codex-proxy"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "ensure.log"
$stdoutPath = Join-Path $logDir "proxy.stdout.log"
$stderrPath = Join-Path $logDir "proxy.stderr.log"
$pidPath = Join-Path $logDir "proxy.pid"

function Write-Log {
    param([string]$Message)
    $stamp = (Get-Date).ToString("o")
    Add-Content -LiteralPath $logPath -Value "$stamp $Message"
}

if (-not (Test-Path -LiteralPath $AuthFile)) {
    throw "Codex auth file missing: $AuthFile. Sign in with Codex CLI first."
}

$check = Get-ProxyHealth -BaseUrl $baseUrl
if ($check.Ok -and $check.Spark -and -not $ForceRestart) {
    Write-Step "already healthy on $baseUrl with model $RequiredModel"
    Write-Log "healthy models=$($check.Models)"
    exit 0
}

if ($ForceRestart) {
    Write-Step "force restart requested on port $Port"
    Stop-ProxyOnPort -ListenPort $Port
}

$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if (-not $npx) {
    $npx = (Get-Command npx -ErrorAction SilentlyContinue).Source
}
if (-not $npx) {
    throw "npx not found on PATH. Install Node.js first."
}

Write-Step "starting @thkdog/codex-openai-proxy on $baseUrl"
Write-Log "starting proxy auth=$AuthFile"

$argumentList = @(
    "--yes",
    "@thkdog/codex-openai-proxy",
    "--host", $HostAddress,
    "--port", "$Port",
    "--auth-file", $AuthFile
)

$process = Start-Process `
    -FilePath $npx `
    -ArgumentList $argumentList `
    -WorkingDirectory $logDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id
Write-Log "started pid=$($process.Id)"

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    Start-Sleep -Seconds 2
    $check = Get-ProxyHealth -BaseUrl $baseUrl
    if ($check.Ok -and $check.Spark) {
        Write-Step "healthy on $baseUrl (pid=$($process.Id); models include $RequiredModel)"
        Write-Log "healthy models=$($check.Models)"
        exit 0
    }
} while ((Get-Date) -lt $deadline)

Write-Log "failed lastError=$($check.Error) models=$($check.Models)"
throw "Codex proxy did not become healthy on $baseUrl within ${WaitSeconds}s. Last error: $($check.Error)"
