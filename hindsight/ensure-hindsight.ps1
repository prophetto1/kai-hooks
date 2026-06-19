param(
    [int]$Port = 10003,
    [string]$HostAddress = "127.0.0.1",
    [string]$BankId = "collective",
    [string]$SecretFile = "E:\writing-system\secrets\dev\llm-providers.yaml",
    [string]$HindsightExe = "$env:USERPROFILE\.local\bin\hindsight-api.exe",
    [int]$WaitSeconds = 240
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

function Start-Hindsight {
    param(
        [string]$SecretPath,
        [string]$ExePath,
        [string]$BindHost,
        [int]$BindPort
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

    $child = @"
`$ErrorActionPreference = 'Stop'
`$logDir = Join-Path `$env:LOCALAPPDATA 'hindsight-native'
New-Item -ItemType Directory -Force -Path `$logDir | Out-Null
`$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
`$out = Join-Path `$logDir "hindsight-api-`$stamp.out.log"
`$err = Join-Path `$logDir "hindsight-api-`$stamp.err.log"
if (-not `$env:HINDSIGHT_API_LLM_API_KEY -and `$env:OPENAI_API_KEY) { `$env:HINDSIGHT_API_LLM_API_KEY = `$env:OPENAI_API_KEY }
if (-not `$env:HINDSIGHT_API_LLM_API_KEY) { throw 'HINDSIGHT_API_LLM_API_KEY missing after SOPS exec-env' }
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
if ($initial.Ok) {
    Write-Step "already healthy on $endpoint with $($initial.ToolCount) MCP tools"
    exit 0
}

Write-Step "not healthy yet: $($initial.Error)"
Start-Hindsight -SecretPath $SecretFile -ExePath $HindsightExe -BindHost $HostAddress -BindPort $Port

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
