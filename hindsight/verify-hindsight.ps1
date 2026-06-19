param(
    [int]$Port = 10003,
    [string]$HostAddress = "127.0.0.1",
    [string]$BankId = "collective",
    [int]$TimeoutSec = 30,
    [switch]$RetainSmoke
)

$ErrorActionPreference = "Stop"

$uri = "http://$HostAddress`:$Port/mcp/$BankId/"
$headers = @{ Accept = "application/json, text/event-stream" }

$initBody = @{
    jsonrpc = "2.0"
    id = 1
    method = "initialize"
    params = @{
        protocolVersion = "2024-11-05"
        capabilities = @{}
        clientInfo = @{
            name = "hindsight-verify"
            version = "1.0.0"
        }
    }
} | ConvertTo-Json -Depth 10

$initResponse = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -Headers $headers -ContentType "application/json" -Body $initBody -TimeoutSec $TimeoutSec
$sessionId = $initResponse.Headers["mcp-session-id"]
if (-not $sessionId) {
    $sessionId = $initResponse.Headers["Mcp-Session-Id"]
}
if (-not $sessionId) {
    throw "initialize returned no MCP session id"
}

$headers["mcp-session-id"] = $sessionId
$toolsBody = @{
    jsonrpc = "2.0"
    id = 2
    method = "tools/list"
    params = @{}
} | ConvertTo-Json -Depth 10

$toolsResponse = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -Headers $headers -ContentType "application/json" -Body $toolsBody -TimeoutSec $TimeoutSec
$content = $toolsResponse.Content
if ($content -match "^event:") {
    $jsonLine = ($content -split "`n" | Where-Object { $_ -like "data: *" } | Select-Object -First 1)
    if (-not $jsonLine) {
        throw "tools/list returned SSE without data"
    }
    $content = $jsonLine.Substring(6)
}

$parsed = $content | ConvertFrom-Json
$toolNames = @($parsed.result.tools | ForEach-Object { $_.name })
$requiredTools = @("recall", "list_memories", "reflect", "sync_retain")
$missing = @($requiredTools | Where-Object { $toolNames -notcontains $_ })
$retainSmokeOk = $null
$retainSmokeError = $null

if ($RetainSmoke) {
    $stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    $smokeBody = @{
        jsonrpc = "2.0"
        id = 3
        method = "tools/call"
        params = @{
            name = "sync_retain"
            arguments = @{
                content = "Hindsight retain smoke check at $stamp. The retain LLM must extract this diagnostic fact for bank $BankId."
                context = "diagnostic"
                tags = @("hindsight-retain-smoke", "hooks")
                metadata = @{
                    source = "E:/hooks/hindsight/verify-hindsight.ps1"
                    bank = $BankId
                }
            }
        }
    } | ConvertTo-Json -Depth 10

    try {
        $smokeResponse = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -Headers $headers -ContentType "application/json" -Body $smokeBody -TimeoutSec ([Math]::Max($TimeoutSec, 180))
        $smokeContent = $smokeResponse.Content
        if ($smokeContent -match "^event:") {
            $jsonLine = ($smokeContent -split "`n" | Where-Object { $_ -like "data: *" } | Select-Object -First 1)
            if (-not $jsonLine) {
                throw "sync_retain returned SSE without data"
            }
            $smokeContent = $jsonLine.Substring(6)
        }
        $smokeParsed = $smokeContent | ConvertFrom-Json
        $retainSmokeOk = -not [bool]$smokeParsed.result.isError
        if (-not $retainSmokeOk) {
            $retainSmokeError = ($smokeParsed.result.content | ForEach-Object { $_.text }) -join " "
        }
    } catch {
        $retainSmokeOk = $false
        $retainSmokeError = $_.Exception.Message
    }
}

[pscustomobject]@{
    Endpoint = $uri
    InitializeStatus = $initResponse.StatusCode
    ToolsStatus = $toolsResponse.StatusCode
    SessionPresent = [bool]$sessionId
    ToolCount = $toolNames.Count
    RequiredToolsPresent = ($missing.Count -eq 0)
    Missing = $missing -join ","
    RetainSmokeRequested = [bool]$RetainSmoke
    RetainSmokeOk = $retainSmokeOk
    RetainSmokeError = $retainSmokeError
    SampleTools = ($toolNames | Select-Object -First 12) -join ", "
} | Format-List

if ($missing.Count -gt 0) {
    exit 1
}
if ($RetainSmoke -and -not $retainSmokeOk) {
    exit 1
}
