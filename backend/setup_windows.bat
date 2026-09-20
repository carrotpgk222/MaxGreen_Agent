@echo off
setlocal
cd /d "%~dp0"

echo ====================================================
echo MaxGreen Agent - Python backend setup
echo ====================================================

set "PYTHON_CMD="
where py >nul 2>nul && set "PYTHON_CMD=py"
if not defined PYTHON_CMD (
  where python >nul 2>nul && set "PYTHON_CMD=python"
)

if not defined PYTHON_CMD (
  echo ERROR: Python was not found.
  echo Install Python 3.11 or 3.12 from https://www.python.org/downloads/
  echo IMPORTANT: tick "Add python.exe to PATH" during installation.
  pause
  exit /b 1
)

%PYTHON_CMD% --version

echo.
echo Creating virtual environment...
%PYTHON_CMD% -m venv .venv
if errorlevel 1 goto :error

echo.
echo Installing Python packages...
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 goto :error

echo.
echo ====================================================
echo SETUP COMPLETE

echo Next: put credentials.json into backend\secrets\
echo Then double-click connect_gmail.bat

echo ====================================================
pause
exit /b 0

:error
echo.
echo Setup failed. Copy the error above and send it to ChatGPT.
pause
exit /b 1
