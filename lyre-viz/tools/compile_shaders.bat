@echo off
rem Recompile shaders\lyreviz.glsl -> src\shaders\lyreviz.glsl.h (Metal + Direct3D 11 + OpenGL)
rem A lancer seulement apres avoir modifie les shaders. Telecharge sokol-shdc au premier lancement.
setlocal
cd /d "%~dp0\.."
set "SHDC=tools\bin\sokol-shdc.exe"
if exist "%SHDC%" goto run
if not exist tools\bin mkdir tools\bin
echo Telechargement de sokol-shdc...
curl.exe -fL -o "%SHDC%" "https://raw.githubusercontent.com/floooh/sokol-tools-bin/master/bin/win32/sokol-shdc.exe"
if errorlevel 1 goto failed
:run
"%SHDC%" -i shaders\lyreviz.glsl -o src\shaders\lyreviz.glsl.h -l glsl430:hlsl5:metal_macos --ifdef
if errorlevel 1 goto failed
echo OK : src\shaders\lyreviz.glsl.h
exit /b 0
:failed
echo ECHEC
exit /b 1
