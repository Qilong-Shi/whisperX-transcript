[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$DataRoot = if ([string]::IsNullOrWhiteSpace($env:WHISPERX_DATA_ROOT)) {
    "D:\AI\WhisperX"
} else {
    $env:WHISPERX_DATA_ROOT
}
$VenvRoot = Join-Path $DataRoot "venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
$CacheRoot = Join-Path $DataRoot "cache"
$TempRoot = Join-Path $DataRoot "temp"

if (-not (Test-Path (Split-Path -Qualifier $DataRoot))) {
    throw "The target drive for WHISPERX_DATA_ROOT does not exist: $DataRoot"
}

@(
    $DataRoot,
    $CacheRoot,
    $TempRoot,
    (Join-Path $CacheRoot "huggingface"),
    (Join-Path $CacheRoot "torch"),
    (Join-Path $CacheRoot "nltk"),
    (Join-Path $CacheRoot "cuda"),
    (Join-Path $CacheRoot "pip"),
    (Join-Path $DataRoot "models"),
    (Join-Path $DataRoot "ffmpeg")
) | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:HF_HOME = Join-Path $CacheRoot "huggingface"
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
$env:TORCH_HOME = Join-Path $CacheRoot "torch"
$env:XDG_CACHE_HOME = $CacheRoot
$env:NLTK_DATA = Join-Path $CacheRoot "nltk"
$env:CUDA_CACHE_PATH = Join-Path $CacheRoot "cuda"
$env:PIP_CACHE_DIR = Join-Path $CacheRoot "pip"

Set-Location $ProjectRoot

function Get-CompatibleFFmpeg {
    return Get-ChildItem `
        (Join-Path $DataRoot "ffmpeg") `
        -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\ffmpeg-7\." } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
}

function Install-CompatibleFFmpeg {
    if ($null -ne (Get-CompatibleFFmpeg)) {
        return
    }

    $archive = Join-Path $TempRoot "ffmpeg-7.1.1-full_build-shared.zip"
    $destination = Join-Path $DataRoot "ffmpeg"
    $url = "https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-full_build-shared.zip"

    Write-Host "Downloading FFmpeg Shared 7.1.1 to $destination..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
    Remove-Item -LiteralPath $archive -Force

    if ($null -eq (Get-CompatibleFFmpeg)) {
        throw "FFmpeg was downloaded but ffmpeg.exe was not found under $destination."
    }
}

function Enable-CompatibleFFmpeg {
    $ffmpeg = Get-CompatibleFFmpeg

    if ($null -eq $ffmpeg) {
        return $false
    }

    $ffmpegDir = $ffmpeg.Directory.FullName
    $env:Path = "$ffmpegDir;$env:Path"
    $env:WHISPERX_FFMPEG_DIR = $ffmpegDir
    $env:PYTHONPATH = if ([string]::IsNullOrWhiteSpace($env:PYTHONPATH)) {
        $ProjectRoot
    } else {
        "$ProjectRoot$([IO.Path]::PathSeparator)$env:PYTHONPATH"
    }
    return $true
}

$pythonVersion = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($LASTEXITCODE -ne 0) {
    throw "Python was not found. Install Python 3.10-3.12 first."
}

$supportedVersions = @("3.10", "3.11", "3.12")
if ($pythonVersion -notin $supportedVersions) {
    throw "Python $pythonVersion is unsupported. WhisperX requires Python 3.10-3.12."
}

Install-CompatibleFFmpeg

if (-not (Test-Path $VenvPython)) {
    Write-Host "[1/4] Creating the Python environment at $VenvRoot..."
    python -m venv $VenvRoot
    if ($LASTEXITCODE -ne 0) { throw "Failed to create the virtual environment." }
} else {
    Write-Host "[1/4] Reusing the existing environment at $VenvRoot."
}

Write-Host "[2/4] Updating pip..."
& $VenvPython -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw "Failed to update pip." }

Write-Host "[3/4] Installing PyTorch 2.8 for CUDA 12.8..."
& $VenvPython -m pip install --no-cache-dir `
    torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 `
    --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { throw "Failed to install the CUDA build of PyTorch." }

Write-Host "[4/4] Installing WhisperX..."
& $VenvPython -m pip install --no-cache-dir -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Failed to install WhisperX." }

Write-Host ""
Write-Host "Verifying the installation..."
if (-not (Enable-CompatibleFFmpeg)) {
    throw "Compatible FFmpeg shared libraries were not found under $DataRoot\ffmpeg."
}

& $VenvPython -c "import torch, whisperx, ctranslate2, torchcodec; print('WhisperX: OK'); print('TorchCodec: OK'); print('PyTorch:', torch.__version__); print('CUDA runtime:', torch.version.cuda); print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'unavailable'); print('CTranslate2 CUDA types:', ctranslate2.get_supported_compute_types('cuda') if torch.cuda.is_available() else 'N/A')"
if ($LASTEXITCODE -ne 0) { throw "WhisperX import or CUDA verification failed." }

Write-Host "FFmpeg: OK"

Write-Host ""
Write-Host "Installation complete. Example:"
Write-Host '.\transcribe.ps1 "C:\path\to\audio.mp3"'
