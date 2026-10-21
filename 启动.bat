@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Prefer a node on PATH; fall back to the bundled workbuddy node if present.
set "EDGE_TUI_NODE=node"
where node >nul 2>nul || set "EDGE_TUI_NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
"%EDGE_TUI_NODE%" run.mjs %*
