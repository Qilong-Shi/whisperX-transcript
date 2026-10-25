[CmdletBinding()]
param([ValidateRange(1024, 65535)][int] $Port = 8765)
$ErrorActionPreference = "Stop"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw "Node.js 20 or newer is required. Install Node.js, then restart this launcher."
}
& $node.Source (Join-Path $PSScriptRoot "server.js") --port $Port --open
if ($LASTEXITCODE -ne 0) { throw "The local interface exited with an error." }
