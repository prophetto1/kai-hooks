param(
    [string]$HostAddress = "127.0.0.1",
    [int]$Port = 8787,
    [string]$RequiredModel = "gpt-5.3-codex-spark"
)

$ErrorActionPreference = "Stop"
$baseUrl = "http://${HostAddress}:$Port"

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/health" -TimeoutSec 10
    $models = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/v1/models" -TimeoutSec 10).Content | ConvertFrom-Json
    $ids = @($models.data | ForEach-Object { $_.id })
    $sparkOk = $ids -contains $RequiredModel
    [pscustomobject]@{
        BaseUrl = $baseUrl
        HealthOk = ($health.StatusCode -eq 200)
        SparkOk = $sparkOk
        Models = $ids
        RequiredModel = $RequiredModel
    }
    if (-not $sparkOk) {
        exit 1
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
