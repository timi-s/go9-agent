@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   Go9 Agent - 9x9 Go Web App
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)

node -e "if (+process.versions.node.split('.')[0] < 22) process.exit(1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required. Current:
  node --version
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [WARN] Python not found. Built-in AI will fall back to JS MCTS.
  echo        Install Python 3 for the stronger built-in AI.
  echo.
)

if not exist "server\node_modules" (
  echo [1/4] Installing server dependencies...
  pushd server
  call npm install
  if errorlevel 1 goto :fail
  popd
) else (
  echo [1/4] Server dependencies OK.
)

if not exist "client\node_modules" (
  echo [2/4] Installing client dependencies...
  pushd client
  call npm install
  if errorlevel 1 goto :fail
  popd
) else (
  echo [2/4] Client dependencies OK.
)

if not exist "server\generated\prisma" (
  echo [3/4] Generating Prisma client...
  pushd server
  call npx prisma generate
  if errorlevel 1 goto :fail
  popd
) else (
  echo [3/4] Prisma client OK.
)

if not exist "server\dev.db" (
  echo [4/4] Initializing SQLite database...
  pushd server
  call npx prisma migrate deploy
  if errorlevel 1 goto :fail
  popd
) else (
  echo [4/4] Database OK.
)

echo.
echo Starting: frontend http://localhost:5173  backend http://localhost:3001
echo Close this window or press Ctrl+C to stop.
echo.
if not "%GO9_NO_BROWSER%"=="1" start "" /b cmd /c "timeout /t 5 >nul & start http://localhost:5173"
node scripts/dev.mjs
goto :eof

:fail
echo.
echo [ERROR] Startup preparation failed. See the log above.
pause
exit /b 1
