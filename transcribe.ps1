[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]] $Audio,

    [string] $OutputDir = "output",

    [string] $Model = "large-v3",

    [string] $Language = "en",

    [ValidateSet("cuda", "cpu")]
    [string] $Device = "cuda",

    [ValidateRange(1, 64)]
    [int] $BatchSize = 4,

    [ValidateSet("all", "srt", "vtt", "txt", "tsv", "json", "aud")]
    [string] $OutputFormat = "all",

    [ValidateSet("float16", "int8")]
    [string] $ComputeType = "float16",

    [switch] $Diarize,

    [Nullable[int]] $MinSpeakers,

    [Nullable[int]] $MaxSpeakers
)

$ErrorActionPreference = "Stop"
if ($Device -eq "cpu" -and $ComputeType -eq "float16") {
    throw "CPU transcription requires -ComputeType int8."
}
$ProjectRoot = $PSScriptRoot
$DataRoot = if ([string]::IsNullOrWhiteSpace($env:WHISPERX_DATA_ROOT)) {
    "D:\AI\WhisperX"
} else {
    $env:WHISPERX_DATA_ROOT
}
$CacheRoot = Join-Path $DataRoot "cache"
$ModelRoot = Join-Path $DataRoot "models"
$TempRoot = Join-Path $DataRoot "temp"
$Python = Join-Path $DataRoot "venv\Scripts\python.exe"

@(
    $CacheRoot,
    $ModelRoot,
    $TempRoot,
    (Join-Path $CacheRoot "huggingface"),
    (Join-Path $CacheRoot "torch"),
    (Join-Path $CacheRoot "nltk"),
    (Join-Path $CacheRoot "cuda")
) | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:HF_HOME = Join-Path $CacheRoot "huggingface"
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
$env:TORCH_HOME = Join-Path $CacheRoot "torch"
$env:XDG_CACHE_HOME = $CacheRoot
$env:NLTK_DATA = Join-Path $CacheRoot "nltk"
$env:CUDA_CACHE_PATH = Join-Path $CacheRoot "cuda"

if (-not (Test-Path $Python)) {
    throw "The environment is not installed. Run .\setup.ps1 first."
}

$ffmpeg = Get-ChildItem `
    (Join-Path $DataRoot "ffmpeg") `
    -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\ffmpeg-7\." } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if ($null -eq $ffmpeg) {
    throw "Compatible FFmpeg shared libraries were not found under $DataRoot\ffmpeg. Run .\setup.ps1 first."
}

$ffmpegDir = $ffmpeg.Directory.FullName
$env:Path = "$ffmpegDir;$env:Path"
$env:WHISPERX_FFMPEG_DIR = $ffmpegDir
$env:PYTHONPATH = if ([string]::IsNullOrWhiteSpace($env:PYTHONPATH)) {
    $ProjectRoot
} else {
    "$ProjectRoot$([IO.Path]::PathSeparator)$env:PYTHONPATH"
}

$resolvedAudio = foreach ($item in $Audio) {
    if (-not (Test-Path -LiteralPath $item -PathType Leaf)) {
        throw "Audio or video file not found: $item"
    }
    (Resolve-Path -LiteralPath $item).Path
}

$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
} else {
    Join-Path $ProjectRoot $OutputDir
}

$whisperArgs = @(
    "-m", "whisperx"
) + $resolvedAudio + @(
    "--model", $Model,
    "--device", $Device,
    "--compute_type", $ComputeType,
    "--batch_size", $BatchSize,
    "--vad_method", "silero",
    "--model_dir", $ModelRoot,
    "--output_dir", $resolvedOutput,
    "--output_format", $OutputFormat,
    "--print_progress", "True"
)

if (-not [string]::IsNullOrWhiteSpace($Language)) {
    $whisperArgs += @("--language", $Language)
}

if ($Diarize) {
    if ([string]::IsNullOrWhiteSpace($env:HF_TOKEN)) {
        throw "Diarization requires a Hugging Face token. Set `$env:HF_TOKEN before using -Diarize."
    }
    $whisperArgs += "--diarize"
    if ($null -ne $MinSpeakers) {
        $whisperArgs += @("--min_speakers", $MinSpeakers.Value)
    }
    if ($null -ne $MaxSpeakers) {
        $whisperArgs += @("--max_speakers", $MaxSpeakers.Value)
    }
}

Write-Host "Starting transcription. Output directory: $resolvedOutput"
& $Python @whisperArgs
if ($LASTEXITCODE -ne 0) {
    throw "WhisperX failed with exit code $LASTEXITCODE."
}

Write-Host "Transcription complete: $resolvedOutput"
