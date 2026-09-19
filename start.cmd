@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv
  if errorlevel 1 goto error
)
".venv\Scripts\python.exe" -c "import edgepulse,fastapi,uvicorn" >nul 2>&1
if errorlevel 1 (
  ".venv\Scripts\python.exe" -m pip install -c requirements.lock -e .
  if errorlevel 1 goto error
)
echo EdgePulse: http://127.0.0.1:8000
echo Open the URL in your browser. Press Ctrl+C to stop.
".venv\Scripts\python.exe" -m edgepulse.cli serve
if errorlevel 1 goto error
exit /b 0
:error
echo Startup failed. See the error above and README.md.
pause
exit /b 1
