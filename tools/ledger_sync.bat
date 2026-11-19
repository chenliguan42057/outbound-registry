@echo off
chcp 65001 >nul
"C:\Users\clg13\.workbuddy\binaries\python\versions\3.13.12\python.exe" "%~dp0ledger_local_sync.py"
echo.
echo Done. Press any key to close.
pause >nul
