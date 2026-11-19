@echo off
cd /d "%~dp0"
node --env-file=.env worker.js
