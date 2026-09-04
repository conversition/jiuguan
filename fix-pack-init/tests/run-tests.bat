@echo off
rem jiuguan init-fix pack test runner
rem Usage: double-click, or run from cmd
cd /d "%~dp0..\.."
node --experimental-strip-types --experimental-transform-types "%~dp0verify-init-fixes.ts"
echo.
echo ============================================
echo  Test finished. 0 fail = all fixes verified
echo ============================================
pause
