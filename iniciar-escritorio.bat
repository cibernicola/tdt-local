@echo off
cd /d "%~dp0desktop"
rem Arranca la aplicacion de escritorio (Electron). Requiere Node 20+ y "npm install" hecho una vez en desktop\.
rem Ajustes de esta maquina: iniciar.local.bat (no se sube a git).
rem Para que una IA por MCP pueda escribir plugins, descomenta estas dos lineas:
rem set TDT_CONTROL_ENABLED=1
rem set TDT_CONTROL_LEVEL=dev
if exist "%~dp0iniciar.local.bat" call "%~dp0iniciar.local.bat"
if not exist node_modules\electron\dist\electron.exe (
  echo Falta instalar las dependencias: ejecutando npm install...
  call npm install
  if errorlevel 1 goto fallo
)
start "" node_modules\electron\dist\electron.exe .
exit /b 0
:fallo
echo No se pudo instalar. Comprueba que Node 20 o superior esta instalado: https://nodejs.org/
pause
