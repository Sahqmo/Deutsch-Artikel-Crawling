@echo off
setlocal
cd /d "%~dp0"

set "PYTHON=%~dp0.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo [ERROR] Virtual environment not found. Run this first:
    echo   python -m venv .venv
    echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
    echo   .venv\Scripts\python.exe -m spacy download de_core_news_sm
    echo.
    pause
    exit /b 1
)

start "Deutsch Nachrichten Server" cmd /k ""%PYTHON%" app.py"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5000"
