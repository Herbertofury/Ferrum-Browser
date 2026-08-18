Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$artifactDir = if ($env:FERRUM_WINDOWS_ARTIFACTS) { $env:FERRUM_WINDOWS_ARTIFACTS } else { 'artifacts/windows-desktop' }
$serverUrl = if ($env:FERRUM_WINDOWS_WEBDRIVER_URL) { $env:FERRUM_WINDOWS_WEBDRIVER_URL } else { 'http://127.0.0.1:4723' }
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null

$appiumCommand = (Get-Command appium.cmd -ErrorAction Stop).Source
$serverLog = Join-Path $artifactDir 'appium-server.log'
$stdoutLog = Join-Path $artifactDir 'appium-stdout.log'
$stderrLog = Join-Path $artifactDir 'appium-stderr.log'
$appium = Start-Process -FilePath $appiumCommand -ArgumentList @('--address', '127.0.0.1', '--port', '4723', '--log', $serverLog, '--log-level', 'info') -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($appium.HasExited) {
            try { $appium.WaitForExit() } catch {}
            throw "Appium exited before readiness with code $($appium.ExitCode)"
        }
        try {
            $status = Invoke-RestMethod -Uri "$serverUrl/status" -Method Get -TimeoutSec 5
            $status | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $artifactDir 'status.json') -Encoding utf8
            $ready = $true
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $ready) {
        throw 'Appium did not become ready within 90 seconds'
    }

    $started = [System.Diagnostics.Stopwatch]::StartNew()
    & node .\bin\ferrum.mjs test .\examples\self-test-windows-desktop.json --artifacts (Join-Path $artifactDir 'ferrum') --compact
    $exitCode = $LASTEXITCODE
    $started.Stop()

    [ordered]@{
        automationName = $env:FERRUM_WINDOWS_AUTOMATION_NAME
        app = $env:FERRUM_WINDOWS_APP
        elapsedMs = [Math]::Round($started.Elapsed.TotalMilliseconds, 3)
        ferrumExitCode = $exitCode
        server = $serverUrl
    } | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $artifactDir 'metrics.json') -Encoding utf8

    if ($exitCode -ne 0) {
        throw "Ferrum native Windows smoke failed with exit code $exitCode"
    }
} finally {
    if ($appium -and -not $appium.HasExited) {
        & taskkill.exe /PID $appium.Id /T /F 2>$null | Out-Null
    }
    try { $appium.WaitForExit(10000) | Out-Null } catch {}
}
