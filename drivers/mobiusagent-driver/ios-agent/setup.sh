#!/bin/sh
# One-time iOS setup: builds and signs WebDriverAgent (Appium, BSD-3) with YOUR Apple developer team into ~/.mobius/wda.
# mobiusagent-driver then starts it on a USB-connected iPhone on demand.
#
#   MOBIUS_TEAM_ID=XXXXXXXXXX ./setup.sh      (team id: the OU of your "Apple Development" certificate)
#
# Phone: Developer Mode on, paired/trusted with this Mac, UI Automation enabled (Settings → Developer).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TEAM="${MOBIUS_TEAM_ID:?set MOBIUS_TEAM_ID to your Apple developer team id}"
DIR="${MOBIUS_WDA_DIR:-$HOME/.mobius/wda}"
WDA_VERSION="${WDA_VERSION:-v9.15.0}"
[ -d "$DIR/.git" ] || git clone --depth 1 --branch "$WDA_VERSION" https://github.com/appium/WebDriverAgent.git "$DIR"
cd "$DIR"
# Mobius fast touch (tap/swipe without WebDriverAgent's app lookup and settle wait). BSD-3 allows shipping a modified build.
PATCH="$HERE/wda-mobius-fast-touch.patch"
git apply --check "$PATCH" 2>/dev/null && git apply "$PATCH" && echo "applied Mobius fast-touch patch"
xcodebuild build-for-testing -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -destination 'generic/platform=iOS' DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  PRODUCT_BUNDLE_IDENTIFIER="${MOBIUS_WDA_BUNDLE:-dev.mobius.wda}" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration -derivedDataPath "$DIR/build" | grep -E "error:|\*\* " || true
"$HERE/brand.sh"
ls "$DIR"/build/Build/Products/*.xctestrun >/dev/null && echo "WebDriverAgent ready in $DIR"
