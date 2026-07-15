#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="2.4.0"
DEST="${1:-$ROOT/release}"
APP="$DEST/Brainana Viewer Launcher.app"
NODE_ARM_PACKAGE="$ROOT/vendor/node-packages/node-bin-darwin-arm64-22.11.0.tgz"
NODE_X64_PACKAGE="$ROOT/vendor/node-packages/node-darwin-x64-22.11.0.tgz"

extract_node() {
  local archive="$1" destination="$2" temp
  [[ -f "$archive" ]] || { echo "Missing bundled Node package: $archive" >&2; exit 1; }
  temp="$(mktemp -d)"
  tar -xzf "$archive" -C "$temp" package/bin/node package/LICENSE
  mkdir -p "$(dirname "$destination")"
  cp "$temp/package/bin/node" "$destination"
  chmod +x "$destination"
  if [[ ! -f "$DEST/Node.js-LICENSE" ]]; then cp "$temp/package/LICENSE" "$DEST/Node.js-LICENSE"; fi
  rm -rf "$temp"
}

rm -rf "$APP"
mkdir -p "$DEST" "$APP/Contents/MacOS" "$APP/Contents/Resources/viewer" "$APP/Contents/Resources/node/darwin-arm64" "$APP/Contents/Resources/node/darwin-x64" "$APP/Contents/Resources/licenses"
cp "$ROOT/launcher/brainana-launcher" "$APP/Contents/MacOS/brainana-launcher"
chmod +x "$APP/Contents/MacOS/brainana-launcher"
cp "$ROOT/server.mjs" "$ROOT/remote-filesystem.mjs" "$ROOT/filesystem-adapter.mjs" "$ROOT/VERSION.json" "$APP/Contents/Resources/viewer/"
mkdir -p "$APP/Contents/Resources/viewer/scripts"
cp "$ROOT/scripts/profile-store.mjs" "$APP/Contents/Resources/viewer/scripts/"
cp -R "$ROOT/dist" "$APP/Contents/Resources/viewer/dist"
extract_node "$NODE_ARM_PACKAGE" "$APP/Contents/Resources/node/darwin-arm64/node"
extract_node "$NODE_X64_PACKAGE" "$APP/Contents/Resources/node/darwin-x64/node"
cp "$DEST/Node.js-LICENSE" "$APP/Contents/Resources/licenses/Node.js-LICENSE"
rm -f "$DEST/Node.js-LICENSE"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Brainana Viewer Launcher</string>
<key>CFBundleExecutable</key><string>brainana-launcher</string>
<key>CFBundleIdentifier</key><string>org.brainana.viewerlauncher</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Brainana Viewer Launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>20400</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
PLIST
printf 'Packaged %s\n' "$APP"
