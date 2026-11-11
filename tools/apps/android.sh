#!/usr/bin/env bash
# The Android half of run.sh: builds the app for the emulator with the tests' hook, starts the emulator without
# a window and without keeping what the run changes, installs the app and runs android.mjs against it.
#
# Needs JAVA_HOME and NDK_HOME set as for any Android build of the app, the SDK at ANDROID_HOME (or
# ~/Android/Sdk), and an emulator image named by ANDROID_AVD (Medium_Phone_API_37.0 when unset).
set -uo pipefail

work=$1
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
here="$repo/tools/apps"
sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
avd=${ANDROID_AVD:-Medium_Phone_API_37.0}
package=com.sheidesigns.plastikcad
apk="$repo/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
export ANDROID_HOME="$sdk"
export PATH="$sdk/platform-tools:$PATH"

for needed in "$sdk/platform-tools/adb" "$sdk/emulator/emulator"; do
  [ -x "$needed" ] || { echo "Missing: $needed. See the top of tools/apps/android.sh." >&2; exit 2; }
done
if [ -z "${JAVA_HOME:-}" ] || [ -z "${NDK_HOME:-}" ]; then
  echo "JAVA_HOME and NDK_HOME must be set, as for any Android build of the app." >&2
  exit 2
fi
export PATH="$JAVA_HOME/bin:$PATH"

echo "Building the Android app with the tests' hook…"
(cd "$repo" && pnpm tauri android build --debug --target x86_64 --apk --config '{"build":{"beforeBuildCommand":"pnpm exec vite build --mode e2e"}}') > "$work/android-build.log" 2>&1 || { echo "The Android app did not build: $work/android-build.log" >&2; exit 1; }

# Only ever an emulator: a tablet plugged in at the same time is left alone.
emulator_serial() { adb devices | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1; exit }'; }
ours=no
if [ -z "$(emulator_serial)" ]; then
  echo "Starting the emulator…"
  # Read-only: nothing this run does is kept in the image.
  "$sdk/emulator/emulator" -avd "$avd" -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot-save > "$work/android-emulator.log" 2>&1 &
  ours=yes
fi
# Stopped only if this run started it, and waited for: a run begun right after would otherwise take the one
# that is going down for one that is up.
stop_emulator() {
  [ "$ours" = yes ] || return 0
  adb -s "${ANDROID_SERIAL:-emulator-5554}" emu kill > /dev/null 2>&1
  for _ in $(seq 1 30); do
    [ -z "$(adb devices | awk '$1 ~ /^emulator-/ { print $1 }')" ] && break
    sleep 1
  done
}
for _ in $(seq 1 120); do
  serial=$(emulator_serial)
  [ -n "$serial" ] && [ "$(adb -s "$serial" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = "1" ] && break
  sleep 5
done
serial=$(emulator_serial)
if [ -z "$serial" ] || [ "$(adb -s "$serial" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" != "1" ]; then
  echo "The emulator was not up after ten minutes ($work/android-emulator.log). A start from cold sometimes never ends: stop it and run again." >&2
  stop_emulator
  exit 1
fi
export ANDROID_SERIAL="$serial"

# Off the network, and the store's app put to sleep: an emulator fresh from its image updates its web view in the
# background and the system then kills every app that uses it, this one in the middle of a check. Nothing of
# this outlives the run (the emulator is read-only).
adb shell cmd connectivity airplane-mode enable > /dev/null 2>&1
adb shell pm disable-user --user 0 com.android.vending > /dev/null 2>&1

adb install -r "$apk" > "$work/android-install.log" 2>&1 || { echo "The app did not install: $work/android-install.log" >&2; stop_emulator; exit 1; }
# The size of a tablet held upright; the emulator's own is a phone's, which the editor is not made for.
adb shell wm size 1600x2560
adb shell wm density 320
# The first start after the screen changed size does not always stay up: started twice.
for _ in 1 2; do
  adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
  sleep 8
done

# What the app is handed, put where it can read it: its own files.
mkdir -p "$work/android-in"
cp "$repo/fixtures/step/named.step" "$repo/fixtures/gltf/box-draco.glb" "$repo/fixtures/robots/rover.plastikcad" "$work/android-in/"
node "$here/androidFiles.mjs" "$work/android-in"
adb shell "rm -rf /data/local/tmp/in; mkdir -p /data/local/tmp/in"
for file in "$work"/android-in/*; do adb push "$file" /data/local/tmp/in/ > /dev/null; done
adb shell "chmod -R a+rX /data/local/tmp/in"
adb shell "run-as $package sh -c 'mkdir -p files/in && cp /data/local/tmp/in/* files/in/'"

adb logcat -c
node "$here/android.mjs" "$work" "$package" 2>&1 | tee "$work/android.log"
result=${PIPESTATUS[0]}
# What the system said meanwhile: where to look when the app went away.
adb logcat -d > "$work/android-logcat.log" 2>&1
adb forward --remove-all > /dev/null 2>&1
stop_emulator
exit "$result"
