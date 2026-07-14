"""Register the project-selected FFmpeg DLL directory on Windows."""

import os


_FFMPEG_DLL_DIRECTORY_HANDLE = None

if os.name == "nt":
    ffmpeg_dir = os.environ.get("WHISPERX_FFMPEG_DIR")
    if ffmpeg_dir and os.path.isdir(ffmpeg_dir):
        _FFMPEG_DLL_DIRECTORY_HANDLE = os.add_dll_directory(ffmpeg_dir)

