# 本地 WhisperX 语音转文字

本项目在 Windows 上使用 NVIDIA GPU 本地运行 WhisperX。音频内容在本机处理；第一次运行时需要联网下载模型，之后已缓存的模型可以重复使用。

所有大文件都固定存放在 `D:\AI\WhisperX`：

- Python 环境：`D:\AI\WhisperX\venv`
- WhisperX 模型：`D:\AI\WhisperX\models`
- Hugging Face、Torch、NLTK 和 CUDA 缓存：`D:\AI\WhisperX\cache`
- FFmpeg Shared 运行文件：`D:\AI\WhisperX\ffmpeg`
- 安装过程中的临时下载：`D:\AI\WhisperX\temp`

项目目录只保留几个很小的脚本和最终文字输出。

当前电脑的建议配置：

- GPU：RTX 4060 Laptop，8GB 显存
- 模型：`large-v3`
- 计算精度：`float16`
- 批大小：`4`
- 默认语言：英文 `en`（输出英文原文）

## 1. 安装前置软件

本项目的安装脚本会安装带 CUDA 12.8 运行库的 PyTorch wheel。这台电脑已验证无需另外安装完整 CUDA Toolkit；如果以后遇到缺少 CUDA DLL 的错误，再从 NVIDIA 官方页面安装 CUDA Toolkit 12.8：

<https://developer.nvidia.com/cuda-12-8-1-download-archive>

`setup.ps1` 会自动把 TorchCodec 兼容的 FFmpeg Shared 7.1.1 下载到 D 盘，不需要使用 winget 安装到 C 盘。

## 2. 安装 Python 环境

在本目录打开 PowerShell：

```powershell
.\setup.ps1
```

如果 PowerShell 阻止脚本执行，可只为当前窗口放开权限：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

脚本会在 `D:\AI\WhisperX\venv` 创建独立环境，并安装 PyTorch CUDA 12.8 和固定版本的 WhisperX，不会把大型依赖写入本项目所在的 C 盘。

## 3. 转写英文音频

```powershell
.\transcribe.ps1 "C:\path\to\audio.mp3"
```

默认在 `output` 目录生成 `txt`、`srt`、`vtt`、`tsv` 和 `json`。

常用示例：

```powershell
# 只生成纯文本
.\transcribe.ps1 "C:\path\to\audio.mp3" -OutputFormat txt

# 更省显存；速度通常更快，但准确率可能略降
.\transcribe.ps1 "C:\path\to\audio.mp3" -ComputeType int8

# 显存不足时减小批大小
.\transcribe.ps1 "C:\path\to\audio.mp3" -BatchSize 2

# 一次处理多个文件
.\transcribe.ps1 @("a.mp3", "b.mp4")

# 自动识别语言
.\transcribe.ps1 "audio.mp3" -Language ""
```

如果 `large-v3` 显存不足，可改用：

```powershell
.\transcribe.ps1 "audio.mp3" -Model medium -BatchSize 4
```

## 4. 可选：区分不同说话人

先注册 Hugging Face，接受以下模型的使用条款并创建 Read token：

- <https://huggingface.co/pyannote/speaker-diarization-community-1>
- <https://huggingface.co/settings/tokens>

在当前 PowerShell 窗口设置 token（不要把 token 写入项目文件）：

```powershell
$env:HF_TOKEN = "hf_你的token"
.\transcribe.ps1 "meeting.mp3" -Diarize -MinSpeakers 2 -MaxSpeakers 4
```

## 常见问题

- `CUDA out of memory`：先使用 `-BatchSize 2`，仍不足再使用 `-ComputeType int8` 或 `-Model medium`。
- FFmpeg 或 TorchCodec DLL 错误：重新运行 `.\setup.ps1`，它会检查 D 盘的 FFmpeg Shared 7.1.1。
- CUDA DLL 错误：确认已安装 CUDA Toolkit 12.8，而不只是 NVIDIA 显卡驱动。
- 首次运行较慢：需要下载 Whisper 模型、VAD 和中文对齐模型；后续会使用本地缓存。
