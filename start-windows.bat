@echo off
rem Claude 사무실 관제탑 실행 (윈도우). 이 창을 닫으면 관제탑도 꺼집니다.
chcp 65001 >nul
cd /d "%~dp0"
if not exist pets\chiikawa\spritesheet.png node get-pets.js
start "" http://localhost:4317
node server.js
pause
