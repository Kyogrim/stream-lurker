@echo off
title Stream Lurker Launcher
echo ===================================================
echo             Initializing Stream Lurker...
echo ===================================================
cd /d "%~dp0"
if not exist node_modules (
    echo Installing root dependencies...
    call npm install
)
echo Launching application...
call npm start
