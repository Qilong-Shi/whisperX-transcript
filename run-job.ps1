[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $Config)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$parameters = @{
    Audio = @([string]$settings.audio)
    OutputDir = [string]$settings.outputDir
    Model = [string]$settings.model
    Language = [string]$settings.language
    Device = [string]$settings.device
    BatchSize = [int]$settings.batchSize
    OutputFormat = [string]$settings.format
    ComputeType = [string]$settings.computeType
}
& (Join-Path $PSScriptRoot "transcribe.ps1") @parameters
