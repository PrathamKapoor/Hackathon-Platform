#!/bin/sh
# Runtime hardening probe, executed inside the production container.
#
# It lives in a file rather than being passed as a command line for a concrete
# reason: the test harness spawns docker through `cmd.exe` on Windows, which
# strips the quotes around a `sh -c '...'` argument, so the inner command is
# lost and `sh -c cat` runs `cat` with no arguments and reads stdin until the
# test times out. Copying the script in and naming it sidesteps the quoting
# entirely, and it also means the thing being asserted is readable.
#
# One key per line, so the caller can parse it without guessing.

echo "uid=$(id -un 2>/dev/null || id -u)"
echo "pid1=$(cat /proc/1/comm 2>/dev/null)"

if touch /app/.canary 2>/dev/null; then
  echo "app_writable=yes"
else
  echo "app_writable=no"
fi
rm -f /app/.canary 2>/dev/null

if touch /data/.canary 2>/dev/null; then
  echo "data_writable=yes"
else
  echo "data_writable=no"
fi
rm -f /data/.canary 2>/dev/null

if [ -d /app/apps/api/test ]; then
  echo "test_files=present"
else
  echo "test_files=absent"
fi

if [ -d /app/node_modules/vite ] || [ -d /app/node_modules/typescript ]; then
  echo "devdeps=present"
else
  echo "devdeps=pruned"
fi
