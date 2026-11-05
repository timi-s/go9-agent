@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ==========================================
echo   九路围棋 · Go9 Agent
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

node -e "if (+process.versions.node.split('.')[0] < 22) process.exit(1)"
if errorlevel 1 (
  echo [错误] Node.js 版本过低，需要 22 或更高版本。当前版本：
  node --version
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [提示] 未找到 Python，内置 AI 会自动回退到 JS MCTS。
  echo        建议安装 Python 3 以获得更强的内置 AI。
  echo.
)

if not exist "server\node_modules" (
  echo [1/4] 安装后端依赖...
  pushd server
  call npm install
  if errorlevel 1 goto :fail
  popd
) else (
  echo [1/4] 后端依赖已存在。
)

if not exist "client\node_modules" (
  echo [2/4] 安装前端依赖...
  pushd client
  call npm install
  if errorlevel 1 goto :fail
  popd
) else (
  echo [2/4] 前端依赖已存在。
)

if not exist "server\generated\prisma" (
  echo [3/4] 生成 Prisma 客户端...
  pushd server
  call npx prisma generate
  if errorlevel 1 goto :fail
  popd
) else (
  echo [3/4] Prisma 客户端已生成。
)

if not exist "server\dev.db" (
  echo [4/4] 初始化 SQLite 数据库...
  pushd server
  call npx prisma migrate deploy
  if errorlevel 1 goto :fail
  popd
) else (
  echo [4/4] 数据库已存在。
)

echo.
echo 正在启动：前端 http://localhost:5173 ，后端 http://localhost:3001
echo 首次打开可能需要几秒；关闭本窗口或按 Ctrl+C 停止服务。
echo.
if not "%GO9_NO_BROWSER%"=="1" start "" /b cmd /c "timeout /t 5 >nul & start http://localhost:5173"
node scripts/dev.mjs
goto :eof

:fail
echo.
echo [错误] 启动准备失败，请查看上面的日志。
pause
exit /b 1
