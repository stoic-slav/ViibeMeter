#!/usr/bin/env bash
# Quick deploy: bundle JS → copy into DerivedData .app → install + launch on device
set -e

cd "$(dirname "$0")/vibemeter-app"

echo "→ Bundling..."
npx expo export:embed \
  --platform ios \
  --entry-file index.ts \
  --bundle-output /tmp/vibe_bundle.js \
  --assets-dest /tmp/vibe_assets \
  2>&1 | grep -E "(Bundled|Error|error)"

APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData \
  -name "VibeMeter.app" -path "*/Build/Products/Debug-iphoneos/*" \
  ! -path "*/Index.noindex/*" ! -path "*/Intermediates*" \
  2>/dev/null | head -1)

if [ -z "$APP_PATH" ]; then
  echo "✗ VibeMeter.app not found in DerivedData — run a native Xcode build first"
  exit 1
fi

echo "→ Copying bundle to $APP_PATH"
cp /tmp/vibe_bundle.js "$APP_PATH/main.jsbundle"

echo "→ Installing on device..."
ios-deploy --bundle "$APP_PATH" --no-wifi 2>&1 | tail -2

echo "→ Launching to foreground..."
idevicedebug run com.vibemeter.app 2>&1 &
sleep 1

echo "✓ Done"
