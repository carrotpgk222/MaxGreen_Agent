@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Backend is not set up yet.
  echo Run setup_windows.bat first.
  pause
  exit /b 1
)
if not exist "secrets\credentials.json" (
  echo Missing: backend\secrets\credentials.json
  echo Download your Google OAuth Desktop App JSON file,
  echo rename it to credentials.json, and place it in backend\secrets\
  pause
  exit /b 1
)
call .venv\Scripts\activate.bat
python gmail_auth.py
pause
