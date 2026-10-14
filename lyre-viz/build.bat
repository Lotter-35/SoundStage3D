@echo off
rem Compilation de LyreViz sous Windows (Direct3D 11) avec Visual Studio ou les "Build Tools for Visual Studio".
rem   build.bat         -> version optimisee  : LyreViz.exe
rem   build.bat debug   -> version de debogage (couche de validation sokol active)
setlocal
cd /d "%~dp0"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=release"

where cl >nul 2>nul
if not errorlevel 1 goto have_cl
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto no_vs
set "VSPATH="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if "%VSPATH%"=="" goto no_vs
rem vcvars64 cherche lui-meme vswhere.exe dans le PATH
set "PATH=%PATH%;%ProgramFiles(x86)%\Microsoft Visual Studio\Installer"
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
:have_cl

if /i "%MODE%"=="debug" (
    set "OPT=/Od /Zi /MDd"
) else (
    set "OPT=/O2 /DNDEBUG /MD"
)
if not exist build\%MODE% mkdir build\%MODE%

echo Compilation (%MODE%)...
cl /nologo /std:c++17 /EHsc /MP /utf-8 /W1 %OPT% /DSOKOL_D3D11 /Isrc /Iexternal\sokol /Iexternal\imgui /Iexternal\stb ^
   /Fobuild\%MODE%\ /Fdbuild\%MODE%\ ^
   src\main.cpp src\scene.cpp src\fixtures.cpp src\gobos.cpp src\fog.cpp src\renderer.cpp src\ui.cpp src\gpu_profiler.cpp src\floor_texture.cpp src\sokol_impl.cpp ^
   external\imgui\imgui.cpp external\imgui\imgui_draw.cpp external\imgui\imgui_tables.cpp external\imgui\imgui_widgets.cpp ^
   /Fe:LyreViz.exe /link /INCREMENTAL:NO
if errorlevel 1 goto failed
echo.
echo OK : LyreViz.exe
exit /b 0

:no_vs
echo Visual Studio (ou "Build Tools for Visual Studio") est introuvable.
echo Installez-le avec la charge de travail "Developpement Desktop en C++" :
echo   https://visualstudio.microsoft.com/fr/downloads/  (section Outils pour Visual Studio)
exit /b 1

:failed
echo.
echo ECHEC de la compilation.
exit /b 1
