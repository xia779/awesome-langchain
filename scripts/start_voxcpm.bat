@echo off
chcp 65001 >nul
title VoxCPM2 TTS Service
echo ========================================
echo   VoxCPM2 TTS Service (Port 8084)
echo ========================================
echo.

REM ===== Configuration =====
REM Model version: 2b (8GB VRAM, 48kHz) or 0.5b (5GB VRAM, 16kHz)
set MODEL_VERSION=2b

REM Python environment (use system python or specify venv)
set PYTHON_EXE=python

REM HuggingFace mirror (huggingface.co is blocked on this network; mirror is used
REM for the initial model download). Once the model is cached in E:\voxcpm-models
REM you can instead set HF_HUB_OFFLINE=1 for instant offline startup.
set HF_ENDPOINT=https://hf-mirror.com

REM Optional: local model path (skip download)
REM set VOXCPM_MODEL_DIR=E:\voxcpm-models

echo [1/3] Checking voxcpm package...
%PYTHON_EXE% -c "import voxcpm" 2>nul
if %errorlevel% neq 0 (
    echo voxcpm not found. Installing...
    pip install voxcpm torch torchaudio --quiet
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install voxcpm. Please run manually:
        echo   pip install voxcpm torch torchaudio
        pause
        exit /b 1
    )
)
echo OK: voxcpm installed.
echo.

echo [2/3] Starting VoxCPM2 TTS service...
echo   Model: %MODEL_VERSION%
echo   Port: 8084
echo   Press Ctrl+C to stop.
echo.

REM Start service with preload (model loads immediately)
%PYTHON_EXE% "%~dp0tts_voxcpm_service.py" --model %MODEL_VERSION% --preload --port 8084

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Service exited with code %errorlevel%
    echo Common fixes:
    echo   - Not enough VRAM: try --model 0.5b
    echo   - CUDA not available: check torch installation
    echo   - Port in use: change --port to another number
    pause
)
