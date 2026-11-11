#!/usr/bin/env bash
# Tries the built apps before a release: the desktop app as a binary, off the screen, and the Android app on the
# emulator. Each is the real thing (native side, content policy, bundled files) with the tests' hook in its web
# bundle, and is put through what the browser tests cannot reach: the native file commands, every export and
# import, the projects folder, robot exports, the Back key. Not for CI: it needs this workstation's programs.
#
#   pnpm check:apps            both
#   pnpm check:apps desktop    the desktop app only
#   pnpm check:apps android    the Android app only
#
# Needs, for the desktop: cargo, gamescope, WebKitWebDriver (webkitgtk) and dbus-run-session.
# For Android: the SDK with its emulator, an emulator named by ANDROID_AVD, and the build's own needs (README).
# The folder of a run is printed at its end and kept, with the logs and every file the apps wrote.
set -uo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
here="$repo/tools/apps"
what=${1:-all}
work=$(mktemp -d "${TMPDIR:-/tmp}/plastikcad-apps.XXXXXX")
port=${APPS_DRIVER_PORT:-4455}
status=0

need() {
  for program in "$@"; do
    command -v "$program" > /dev/null || { echo "Missing: $program. See the top of tools/apps/run.sh." >&2; exit 2; }
  done
}

desktop() {
  need cargo gamescope WebKitWebDriver dbus-run-session curl setsid
  if curl -s -m 2 "http://127.0.0.1:$port/status" > /dev/null; then
    echo "Port $port is in use: another driver is running. Stop it, or set APPS_DRIVER_PORT." >&2
    return 2
  fi
  echo "Building the desktop app with the tests' hook…"
  (cd "$repo" && pnpm exec vite build "$repo" --mode e2e) > "$work/desktop-web-build.log" 2>&1 || { echo "The web bundle did not build: $work/desktop-web-build.log" >&2; return 1; }
  (cd "$repo/src-tauri" && cargo build --features tauri/custom-protocol) > "$work/desktop-native-build.log" 2>&1 || { echo "The native side did not build: $work/desktop-native-build.log" >&2; return 1; }

  # The app must not reach the real session. It reads the Google Drive sign-in from the system's keychain over
  # the session's message bus: started on that bus it would sync with the real Drive, and what the checks
  # delete would be deleted there. So: a bus of its own (dbus-run-session), a home of its own, and a display
  # of its own that no window of it can leave (gamescope without a screen; WAYLAND_DISPLAY unset, or GTK opens
  # on the real one). desktop.mjs then checks, before anything else, that no Drive is linked.
  mkdir -p "$work/home" "$work/xdg/data" "$work/xdg/config" "$work/xdg/cache"
  real_bus=${DBUS_SESSION_BUS_ADDRESS:-none}
  (cd "$work" && exec setsid dbus-run-session -- env -u WAYLAND_DISPLAY HOME="$work/home" GDK_BACKEND=x11 \
    XDG_DATA_HOME="$work/xdg/data" XDG_CONFIG_HOME="$work/xdg/config" XDG_CACHE_HOME="$work/xdg/cache" \
    TAURI_WEBVIEW_AUTOMATION=true \
    gamescope --backend headless -W 1600 -H 1000 -- \
    sh -c 'echo "$DBUS_SESSION_BUS_ADDRESS" > bus.txt; [ "$DISPLAY" != ":0" ] && exec WebKitWebDriver --port='"$port") > "$work/desktop-driver.log" 2>&1 &
  driver=$!
  stop_driver() { kill -- "-$driver" 2> /dev/null; wait "$driver" 2> /dev/null; }
  for _ in $(seq 1 60); do
    curl -s -m 2 "http://127.0.0.1:$port/status" > /dev/null && break
    sleep 0.5
  done
  if ! curl -s -m 2 "http://127.0.0.1:$port/status" > /dev/null; then
    echo "The driver did not start: $work/desktop-driver.log" >&2
    stop_driver
    return 1
  fi
  if [ ! -s "$work/bus.txt" ] || [ "$(cat "$work/bus.txt")" = "$real_bus" ]; then
    echo "The driver is on the real session's bus: stopped before the app was started." >&2
    stop_driver
    return 3
  fi
  node "$here/desktop.mjs" "http://127.0.0.1:$port" "$repo/src-tauri/target/debug/plastikcad" "$work" "$repo" 2>&1 | tee "$work/desktop.log"
  result=${PIPESTATUS[0]}
  stop_driver
  return "$result"
}

case "$what" in
  desktop) desktop || status=$? ;;
  android) "$here/android.sh" "$work" || status=$? ;;
  all)
    desktop || status=$?
    "$here/android.sh" "$work" || status=$?
    ;;
  *) echo "Usage: pnpm check:apps [desktop|android|all]" >&2; exit 2 ;;
esac

# The bundle with the hook is not left where a build would pick it up.
echo "Putting the plain web bundle back…"
(cd "$repo" && pnpm exec vite build "$repo") > "$work/web-build-after.log" 2>&1 || echo "The plain bundle did not build: $work/web-build-after.log" >&2

echo
if [ "$status" -eq 0 ]; then echo "All checks passed. Logs and files: $work"; else echo "Some checks failed (see above). Logs and files: $work"; fi
exit "$status"
