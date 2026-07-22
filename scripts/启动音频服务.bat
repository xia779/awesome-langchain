@echo off
title AI 漫剧音频服务
chcp 65001 >nul
echo ========================================
echo   AI 漫剧音频服务启动器
echo ========================================
echo.
echo  Fish Speech TTS  -> http://127.0.0.1:8081
echo  AudioLDM-S SFX   -> http://127.0.0.1:8082
echo  MusicGen BGM     -> http://127.0.0.1:8083
echo.
echo  按 Ctrl+C 停止所有服务
echo ========================================
echo.

cd /d E:\my-ai-desktop\scripts
E:\ComfyUI\venv\Scripts\python.exe audio_services.py --all

pause
