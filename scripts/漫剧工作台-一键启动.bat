@echo off
title AI 漫剧工作台 - 一键启动
chcp 65001 >nul
echo ============================================
echo   AI 漫剧工作台 - 一键启动所有服务
echo ============================================
echo.

echo [1/3] 启动 ComfyUI (图像生成)...
start "ComfyUI" cmd /k "cd /d E:\ComfyUI && set PYTHONUTF8=1 && venv\Scripts\python.exe main.py"
timeout /t 5 /nobreak >nul

echo [2/3] 启动音频服务 (TTS/SFX/BGM)...
start "音频服务" cmd /k "cd /d E:\my-ai-desktop\scripts && E:\ComfyUI\venv\Scripts\python.exe audio_services.py"
timeout /t 3 /nobreak >nul

echo [3/3] 检查服务状态...
echo.
echo 请确认以下服务已启动:
echo   - ComfyUI    -> http://127.0.0.1:8188
echo   - Fish TTS   -> http://127.0.0.1:8081
echo   - AudioLDM   -> http://127.0.0.1:8082
echo   - MusicGen   -> http://127.0.0.1:8083
echo   - Ollama     -> http://127.0.0.1:11434 (通常已自动启动)
echo.
echo ============================================
echo  全部服务已启动！现在可以在 AI Agent Pro 中
echo  使用 /manga-auto 命令开始自动生成漫剧
echo ============================================
echo.
pause
