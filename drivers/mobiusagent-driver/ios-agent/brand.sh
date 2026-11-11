#!/bin/sh
# Brand the WebDriverAgent runner as "Mobius Agent" with the Mobius icon, then re-sign it with the same identity.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(ls -d "${MOBIUS_WDA_DIR:-$HOME/.mobius/wda}"/build/Build/Products/Debug-iphoneos/*-Runner.app | head -1)"
python3 "$HERE/brand.py" "$APP" >/dev/null && rm -f "$APP/icon-1024.png"
P="$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIcons" "$P" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :CFBundleDisplayName" "$P" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Mobius Agent" \
  -c "Add :CFBundleIcons dict" -c "Add :CFBundleIcons:CFBundlePrimaryIcon dict" \
  -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles array" \
  -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:0 string AppIcon60x60" \
  -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconName string AppIcon" "$P"
IDENTITY="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
codesign -d --entitlements :- "$APP" > "$APP.entitlements.plist" 2>/dev/null
codesign -f -s "$IDENTITY" --entitlements "$APP.entitlements.plist" --generate-entitlement-der "$APP" 2>&1 | grep -v "replacing existing signature" || true
rm -f "$APP.entitlements.plist"
codesign --verify --deep --strict "$APP" && echo "branded and re-signed: $APP ($IDENTITY)"
