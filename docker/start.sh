#!/bin/sh
# HEADLESS=true  -> plain headless Chromium, no live view.
# HEADLESS=false -> headed Chromium on a virtual display, exposed via noVNC on :6080.
set -e
if [ "$HEADLESS" = "false" ]; then
  : "${VNC_PASSWORD:?Set VNC_PASSWORD when HEADLESS=false (live view is a logged-in browser)}"
  export DISPLAY=:99
  # -ac disables X11 access control (no auth cookie needed) -- without it,
  # x11vnc can't authenticate against this display and exits immediately with
  # only its own "try -auth guess" help text, leaving nothing on port 5900.
  Xvfb :99 -screen 0 1366x900x24 -ac &
  # Wait for Xvfb's socket to actually exist before starting x11vnc against it.
  for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
  x11vnc -display :99 -forever -shared -passwd "$VNC_PASSWORD" -localhost -quiet &
  websockify --web=/usr/share/novnc 6080 localhost:5900 &
fi
exec node src/index.js
