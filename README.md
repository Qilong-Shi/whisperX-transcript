# 本地 WhisperX 语音转文字

本项目在 Windows 上使用 NVIDIA GPU 或 CPU 本地运行 WhisperX。音频内容在本机处理；第一次运行时需要联网下载模型，之后已缓存的模型可以重复使用。

所有大文件都固定存放在 `D:\AI\WhisperX`：

- Python 环境：`D:\AI\WhisperX\venv`
- WhisperX 模型：`D:\AI\WhisperX\models`
- Hugging Face、Torch、NLTK 和 CUDA 缓存：`D:\AI\WhisperX\cache`
- FFmpeg Shared 运行文件：`D:\AI\WhisperX\ffmpeg`
- 安装过程中的临时下载：`D:\AI\WhisperX\temp`

项目目录只保留几个很小的脚本和最终文字输出。

## 网页前端

双击本目录的 **`启动前端.bat`**，会自动打开中文界面。也可以在 PowerShell 中运行：

```powershell
.\start-ui.ps1
```

前端需要 Node.js 20 或以上版本，无需安装 npm 依赖。启动后访问 <http://127.0.0.1:8765>；转录期间保持启动窗口打开，关闭窗口会停止服务，运行中的转录也可能中断。

1. 点击或拖拽上传一个音频/视频文件，最大 4 GB。
2. 选择 TXT、SRT、VTT 或全部格式（TXT / SRT / VTT / TSV / JSON）。
3. 设置输出文件名、音频语言，点击「选择文件夹」打开网页内弹窗，切换磁盘或进入子文件夹，再点击「使用此文件夹」。也可以直接输入完整路径。
4. 点击「开始转录」。运行日志显示模型加载和识别过程；完成后可预览 TXT、下载各个结果文件。

默认语言仍为英语；中文音频请选择「中文」，不确定时选择「自动识别」。高级设置可调整模型、运行设备、计算精度和批大小。网页默认自动选择可用 GPU，没有可用 CUDA 时使用 CPU + int8；CPU 转录较慢，可选较小模型（`tiny.en` 仅支持英语）。网页当前一次处理一个文件，不提供说话人区分；如需该功能，使用下方命令行方式。

每个任务会在选定位置创建独立子文件夹，避免覆盖已有结果。上传的原始媒体暂存于 `D:\AI\WhisperX\temp\web-ui`（遵循 `WHISPERX_DATA_ROOT`）；成功后删除临时媒体，失败时保留以便诊断。任务配置会留在该临时目录中。服务重启后页面任务记录会清空，已保存的结果文件仍可在文件夹中找到。

服务只监听本机地址，上传不会发送到外部转录服务。首次使用未缓存的模型仍需联网下载。界面会检查实际 Python 启动、WhisperX/FFmpeg 安装和 CUDA 可访问性；DLL 或模型加载错误会在运行日志中显示。

端口被占用时运行 `.\start-ui.ps1 -Port 8766`。环境异常时先运行 `.\setup.ps1`，然后刷新页面。运行 `npm test` 可验证 HTTP 上传、保存、下载、错误处理和任务互斥；这些测试使用独立测试进程替代 GPU 推理。

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

# 当前无法使用 GPU 时在 CPU 上转录（速度较慢）
.\transcribe.ps1 "audio.mp3" -Device cpu -ComputeType int8

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
