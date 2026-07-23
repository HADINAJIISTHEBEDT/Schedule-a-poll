#!/usr/bin/env bash
# Sign releases/poll-scheduler.apk with Play-compatible v1+v2+v3 signatures.
# Does not modify application source code.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="${1:-$ROOT/releases/poll-scheduler.apk}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$ROOT/android-sdk}}"
BT="$SDK_ROOT/build-tools/34.0.0"
KS="$ROOT/android/keystore/poll-scheduler-release.keystore"
STOREPASS="${APK_STOREPASS:-PollSched2026!}"
KEYPASS="${APK_KEYPASS:-PollSched2026!}"
ALIAS="${APK_KEY_ALIAS:-pollscheduler}"

if [[ ! -f "$APK" ]]; then
  echo "APK not found: $APK" >&2
  exit 1
fi
if [[ ! -x "$BT/apksigner" || ! -x "$BT/zipalign" ]]; then
  echo "Android build-tools 34.0.0 required at $BT" >&2
  exit 1
fi
if [[ ! -f "$KS" ]]; then
  echo "Keystore missing: $KS" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cp "$APK" "$WORKDIR/original.apk"
mkdir -p "$WORKDIR/apkout"
unzip -q "$WORKDIR/original.apk" -d "$WORKDIR/apkout"
rm -rf "$WORKDIR/apkout/META-INF"
( cd "$WORKDIR/apkout" && zip -qr -X "$WORKDIR/unsigned.apk" . )
"$BT/zipalign" -f -p 4 "$WORKDIR/unsigned.apk" "$WORKDIR/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KS" \
  --ks-pass "pass:$STOREPASS" \
  --ks-key-alias "$ALIAS" \
  --key-pass "pass:$KEYPASS" \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --out "$APK" \
  "$WORKDIR/aligned.apk"

"$BT/apksigner" verify --verbose "$APK"
echo "Signed (v1/v2/v3): $APK"
