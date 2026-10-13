@echo off
rem ─────────────────────────────────────────────────────────────
rem  SoundStage3D : lance le serveur multijoueur / audio (port 8068) et le serveur web du jeu (port 8067),
rem  puis ouvre le jeu dans le navigateur. Fermer une des deux fenêtres arrête le serveur correspondant.
rem ─────────────────────────────────────────────────────────────
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js est introuvable : installe-le depuis https://nodejs.org puis relance ce fichier.
    pause
    exit /b 1
)

if not exist "server\node_modules" (
    echo Installation des dependances du serveur...
    call npm install --prefix server
)

start "SoundStage3D - serveur (8068)" cmd /k node server\server.js
start "SoundStage3D - jeu (8067)" cmd /k node tools\web-server.js

timeout /t 2 /nobreak >nul
start "" "http://localhost:8067"
