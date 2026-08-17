$ErrorActionPreference = 'Stop'

$architectureDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$templatePath = Join-Path $architectureDir 'architecture.template.html'
$outputPath = Join-Path $architectureDir 'architecture.html'
$iconDir = Join-Path $architectureDir 'icons'

function Convert-ToDataUri([string]$path) {
    $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
    $mime = switch ($extension) {
        '.png' { 'image/png' }
        '.svg' { 'image/svg+xml' }
        default { throw "Unsupported icon format: $extension" }
    }
    return "data:$mime;base64,$([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)))"
}

$html = [IO.File]::ReadAllText($templatePath)
$html = $html.Replace('{{SLACK_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'slack-icon.png')))
$html = $html.Replace('{{CLOUDFLARE_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'cloudflare-logo.png')))
$html = $html.Replace('{{GEMINI_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'gemini-icon-128.png')))
$html = $html.Replace('{{WORKERS_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'cloudflare-workers.svg')))
$html = $html.Replace('{{QUEUES_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'cloudflare-queues.svg')))
$html = $html.Replace('{{AI_GATEWAY_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'cloudflare-ai-gateway.svg')))
$html = $html.Replace('{{DURABLE_OBJECTS_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'cloudflare-durable-objects.svg')))
$html = $html.Replace('{{D1_DATA_URI}}', (Convert-ToDataUri (Join-Path $iconDir 'cloudflare-d1.svg')))

[IO.File]::WriteAllText($outputPath, $html, [Text.UTF8Encoding]::new($false))
Write-Output "Generated: $outputPath"
