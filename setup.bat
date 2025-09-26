@echo off
REM JSOS Setup Script for Windows
REM This script sets up the development environment

echo JSOS Setup Starting...
echo ==========================

REM Check if Docker is running
docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Docker is not running. Please start Docker and try again.
    exit /b 1
)

echo Docker is running

REM Check if docker-compose is available
docker-compose --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo docker-compose is not installed. Please install Docker Compose.
    exit /b 1
)

echo Docker Compose is available

REM Install npm dependencies
echo Installing npm dependencies...
npm install
if %ERRORLEVEL% neq 0 (
    echo npm install failed
    exit /b 1
)

echo npm dependencies installed

REM Build Docker images
echo Building Docker images...
docker-compose build
if %ERRORLEVEL% neq 0 (
    echo Docker build failed
    exit /b 1
)

echo Docker images built

echo.
echo Setup complete!
echo.
echo Next steps:
echo   npm run build     # Build the OS
echo   npm run test      # Test the OS
echo   npm start         # Show all available commands
echo.
echo Happy coding!
