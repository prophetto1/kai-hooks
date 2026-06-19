param(
    [int]$Port = 10003,
    [string]$HostAddress = "127.0.0.1",
    [string]$BankId = "collective",
    [string]$SecretFile = "E:\writing-system\secrets\dev\llm-providers.yaml",
    [string]$HindsightExe = "$env:USERPROFILE\.local\bin\hindsight-api.exe",
    [int]$WaitSeconds = 240,
    [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Output "[hindsight] $Message"
}

function Get-HindsightToolCheck {
    param(
        [string]$Uri,
        [int]$TimeoutSec = 30
    )

    $requiredTools = @("recall", "list_memories", "reflect", "sync_retain")

    try {
        $headers = @{ Accept = "application/json, text/event-stream" }
        $initBody = @{
            jsonrpc = "2.0"
            id = 1
            method = "initialize"
            params = @{
                protocolVersion = "2024-11-05"
                capabilities = @{}
                clientInfo = @{
                    name = "hindsight-ensure"
                    version = "1.0.0"
                }
            }
        } | ConvertTo-Json -Depth 10

        $initResponse = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Post -Headers $headers -ContentType "application/json" -Body $initBody -TimeoutSec $TimeoutSec
        $sessionId = $initResponse.Headers["mcp-session-id"]
        if (-not $sessionId) {
            $sessionId = $initResponse.Headers["Mcp-Session-Id"]
        }
        if (-not $sessionId) {
            return [pscustomobject]@{ Ok = $false; Error = "initialize returned no MCP session id"; ToolCount = 0; Missing = $requiredTools -join "," }
        }

        $headers["mcp-session-id"] = $sessionId
        $toolsBody = @{
            jsonrpc = "2.0"
            id = 2
            method = "tools/list"
            params = @{}
        } | ConvertTo-Json -Depth 10

        $toolsResponse = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Post -Headers $headers -ContentType "application/json" -Body $toolsBody -TimeoutSec $TimeoutSec
        $content = $toolsResponse.Content
        if ($content -match "^event:") {
            $jsonLine = ($content -split "`n" | Where-Object { $_ -like "data: *" } | Select-Object -First 1)
            if (-not $jsonLine) {
                return [pscustomobject]@{ Ok = $false; Error = "tools/list returned SSE without data"; ToolCount = 0; Missing = $requiredTools -join "," }
            }
            $content = $jsonLine.Substring(6)
        }

        $parsed = $content | ConvertFrom-Json
        $toolNames = @($parsed.result.tools | ForEach-Object { $_.name })
        $missing = @($requiredTools | Where-Object { $toolNames -notcontains $_ })

        return [pscustomobject]@{
            Ok = ($missing.Count -eq 0)
            Error = $null
            ToolCount = $toolNames.Count
            Missing = $missing -join ","
        }
    } catch {
        return [pscustomobject]@{ Ok = $false; Error = $_.Exception.Message; ToolCount = 0; Missing = $requiredTools -join "," }
    }
}

function Stop-Hindsight {
    param([string]$ExePath)

    $escapedExe = [Regex]::Escape($ExePath)
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq "hindsight-api.exe" -or ($_.CommandLine -match $escapedExe)
    })

    foreach ($process in $processes) {
        Write-Step "stopping existing hindsight-api process $($process.ProcessId)"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Get-RetainLlmFromConfig {
    param([string]$ConfigPath = "E:/hooks/config.json")

    $defaults = [pscustomobject]@{
        Provider = "openai"
        BaseUrl = "http://127.0.0.1:8787/v1"
        ApiKey = "local"
        Model = "gpt-5.3-codex-spark"
        ReasoningEffort = "medium"
        EnsureScript = "E:/hooks/codex-proxy/ensure-codex-proxy.ps1"
    }
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        return $defaults
    }
    try {
        $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        $harvest = @($config.hooks | Where-Object { $_.id -eq "memory-harvester" } | Select-Object -First 1)
        if (-not $harvest) { return $defaults }
        $hindsight = $harvest.settings.hindsight
        $retain = $hindsight.retainLlm
        if ($retain) {
            if ($retain.provider) { $defaults.Provider = [string]$retain.provider }
            if ($retain.baseUrl) { $defaults.BaseUrl = [string]$retain.baseUrl }
            if ($retain.apiKey) { $defaults.ApiKey = [string]$retain.apiKey }
            if ($retain.model) { $defaults.Model = [string]$retain.model }
            if ($retain.reasoningEffort) { $defaults.ReasoningEffort = [string]$retain.reasoningEffort }
            if ($retain.ensureScript) { $defaults.EnsureScript = [string]$retain.ensureScript }
        }
    } catch {
        Write-Step "config retain LLM parse failed; using defaults: $($_.Exception.Message)"
    }
    return $defaults
}

function Start-Hindsight {
    param(
        [string]$SecretPath,
        [string]$ExePath,
        [string]$BindHost,
        [int]$BindPort,
        [string]$ConfigPath = "E:/hooks/config.json"
    )

    if (-not (Test-Path -LiteralPath $SecretPath)) {
        throw "Secret file not found: $SecretPath"
    }
    if (-not (Test-Path -LiteralPath $ExePath)) {
        throw "Hindsight executable not found: $ExePath"
    }

    $sops = Get-Command sops.exe -ErrorAction SilentlyContinue
    if (-not $sops) {
        $sops = Get-Command sops -ErrorAction SilentlyContinue
    }
    if (-not $sops) {
        throw "sops executable not found on PATH"
    }

    $retainLlm = Get-RetainLlmFromConfig -ConfigPath $ConfigPath
    $ensureProxyScript = $retainLlm.EnsureScript
    if (Test-Path -LiteralPath $ensureProxyScript) {
        Write-Step "ensuring Codex proxy for retain LLM via $ensureProxyScript"
        powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File $ensureProxyScript | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Codex proxy ensure failed with exit code $LASTEXITCODE"
        }
    } else {
        Write-Step "warning: codex proxy ensure script missing: $ensureProxyScript"
    }

    $retainProvider = $retainLlm.Provider
    $retainBaseUrl = $retainLlm.BaseUrl
    $retainApiKey = $retainLlm.ApiKey
    $retainModel = $retainLlm.Model
    $retainReasoning = $retainLlm.ReasoningEffort

    $child = @"
`$ErrorActionPreference = 'Stop'
`$logDir = Join-Path `$env:LOCALAPPDATA 'hindsight-native'
New-Item -ItemType Directory -Force -Path `$logDir | Out-Null
`$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
`$out = Join-Path `$logDir "hindsight-api-`$stamp.out.log"
`$err = Join-Path `$logDir "hindsight-api-`$stamp.err.log"
# The hooks repo config is authoritative. Override any stale SOPS-provided
# Hindsight LLM env so an old Mistral/OpenAI process cannot survive restarts.
`$env:HINDSIGHT_API_LLM_PROVIDER = '$retainProvider'
`$env:HINDSIGHT_API_LLM_BASE_URL = '$retainBaseUrl'
`$env:HINDSIGHT_API_LLM_API_KEY = '$retainApiKey'
`$env:HINDSIGHT_API_LLM_MODEL = '$retainModel'
`$env:HINDSIGHT_API_LLM_REASONING_EFFORT = '$retainReasoning'
`$env:HINDSIGHT_API_RETAIN_LLM_PROVIDER = '$retainProvider'
`$env:HINDSIGHT_API_RETAIN_LLM_BASE_URL = '$retainBaseUrl'
`$env:HINDSIGHT_API_RETAIN_LLM_API_KEY = '$retainApiKey'
`$env:HINDSIGHT_API_RETAIN_LLM_MODEL = '$retainModel'
`$env:HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT = '1'
`$env:HINDSIGHT_API_RETAIN_BATCH_ENABLED = 'false'
`$env:PYTHONUTF8 = '1'
`$env:PYTHONIOENCODING = 'utf-8'
`$env:HINDSIGHT_API_HOST = '$BindHost'
`$env:HINDSIGHT_API_PORT = '$BindPort'
`$env:HINDSIGHT_API_MCP_ENABLED = 'true'
`$env:HINDSIGHT_API_WORKER_ID = 'jon-windows-native'
`$p = Start-Process -FilePath '$ExePath' -ArgumentList '--host','$BindHost','--port','$BindPort','--log-level','info' -WindowStyle Hidden -RedirectStandardOutput `$out -RedirectStandardError `$err -PassThru
Write-Output "STARTED_PID=`$(`$p.Id)"
Write-Output "OUT_LOG=`$out"
Write-Output "ERR_LOG=`$err"
"@

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
    $command = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
    & $sops.Source exec-env $SecretPath $command
    if ($LASTEXITCODE -ne 0) {
        throw "sops exec-env failed with exit code $LASTEXITCODE"
    }
}

$endpoint = "http://$HostAddress`:$Port/mcp/$BankId/"
$initial = Get-HindsightToolCheck -Uri $endpoint -TimeoutSec 5
if ($initial.Ok -and -not $ForceRestart) {
    Write-Step "already healthy on $endpoint with $($initial.ToolCount) MCP tools"
    exit 0
}

if ($ForceRestart) {
    Write-Step "force restart requested"
    Stop-Hindsight -ExePath $HindsightExe
    Start-Sleep -Seconds 2
}

Write-Step "not healthy yet: $($initial.Error)"
Start-Hindsight -SecretPath $SecretFile -ExePath $HindsightExe -BindHost $HostAddress -BindPort $Port -ConfigPath "E:/hooks/config.json"

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    $check = Get-HindsightToolCheck -Uri $endpoint -TimeoutSec 10
    if ($check.Ok) {
        Write-Step "healthy on $endpoint with $($check.ToolCount) MCP tools"
        exit 0
    }
    Start-Sleep -Seconds 3
} while ((Get-Date) -lt $deadline)

Write-Error "Hindsight did not become healthy on $endpoint within $WaitSeconds seconds. Last error: $($check.Error); missing tools: $($check.Missing)"
exit 1
