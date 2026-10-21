#!/usr/bin/env bash
# Build the iOS app locally and ship it to TestFlight's Public group, with no clicking:
#   bash scripts/ship-testflight.sh [--no-build] [--changelog FILE] [--group NAME] [--keep-old]
#
# What it does:
#   1. builds the ipa with `eas build --local` (skipped with --no-build, which ships the newest
#      ~/Downloads/ViibeCheck-build*.ipa instead);
#   2. uploads it to App Store Connect with fastlane pilot (no Transporter, no Apple password), unless that build number is already there;
#   3. waits for Apple to process it, sets the "What to Test" text (no emoji: Apple rejects them), adds it to the group,
#      notifies testers;
#   4. submits it for beta review and expires older builds in that group once it is live (unless --keep-old).
#
# One-time setup: an App Store Connect API key, kept OUTSIDE the repo (never commit it):
#   ~/.appstoreconnect/AuthKey.p8      the key file (App Store Connect → Users and Access →
#                                      Integrations → App Store Connect API → Team Keys →
#                                      "+" with access "App Manager"; it downloads once)
#   ~/.appstoreconnect/viibe.env       KEY_ID=…   (shown next to the key)
#                                      ISSUER_ID=… (shown at the top of that page)
set -euo pipefail
export LANG=en_US.UTF-8

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEY_DIR="$HOME/.appstoreconnect"
GROUP="Public"
CHANGELOG_FILE="$APP_DIR/../docs/testflight-whats-new.txt"
BUILD=1
EXPIRE=true

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --keep-old) EXPIRE=false ;;
    --changelog) CHANGELOG_FILE="$2"; shift ;;
    --group) GROUP="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$KEY_DIR/AuthKey.p8" ] || [ ! -f "$KEY_DIR/viibe.env" ]; then
  echo "Missing the App Store Connect API key. See the setup notes at the top of this script." >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$KEY_DIR/viibe.env"
: "${KEY_ID:?KEY_ID missing in viibe.env}" "${ISSUER_ID:?ISSUER_ID missing in viibe.env}"
[ -s "$CHANGELOG_FILE" ] || { echo "No \"What to Test\" text at $CHANGELOG_FILE" >&2; exit 1; }

# Python helper environment (once): JWT signing + requests, kept next to the key, outside the repo
if [ ! -x "$KEY_DIR/venv/bin/python" ]; then
  python3 -m venv "$KEY_DIR/venv" && "$KEY_DIR/venv/bin/pip" install -q pyjwt cryptography requests
fi
PY="$KEY_DIR/venv/bin/python"
ASC="$APP_DIR/scripts/asc_testflight.py"

# fastlane reads the key as a small JSON file, written next to the key (outside the repo)
API_KEY_JSON="$KEY_DIR/api_key.json"
python3 - "$KEY_DIR/AuthKey.p8" "$KEY_ID" "$ISSUER_ID" "$API_KEY_JSON" <<'PY'
import json, sys
key = open(sys.argv[1]).read()
json.dump({"key_id": sys.argv[2], "issuer_id": sys.argv[3], "key": key, "in_house": False}, open(sys.argv[4], "w"))
PY
chmod 600 "$API_KEY_JSON"

if [ "$BUILD" = 1 ]; then
  OUT="$HOME/Downloads/ViibeCheck-$(date +%Y%m%d-%H%M).ipa"
  echo "Building (about 10–20 minutes)…"
  (cd "$APP_DIR" && npx eas-cli build --platform ios --local --non-interactive --output "$OUT")
  IPA="$OUT"
else
  IPA="$(ls -t "$HOME"/Downloads/ViibeCheck-build*.ipa 2>/dev/null | head -1)"
fi
[ -f "${IPA:-}" ] || { echo "No ipa found." >&2; exit 1; }

# The build number inside the ipa
NUM="$(unzip -p "$IPA" 'Payload/*.app/Info.plist' | plutil -extract CFBundleVersion raw -o - - )"
echo "Build $NUM: $IPA"

if "$PY" "$ASC" has "$NUM"; then
  echo "Build $NUM is already uploaded; skipping the upload."
else
  fastlane pilot upload --ipa "$IPA" --api_key_path "$API_KEY_JSON" --skip_waiting_for_build_processing true
fi

# What to Test, group, beta review, expire older builds
CHANGELOG_ARGS=("$CHANGELOG_FILE" --group "$GROUP")
[ "$EXPIRE" = true ] || CHANGELOG_ARGS+=(--keep-old)
"$PY" "$ASC" publish "$NUM" "${CHANGELOG_ARGS[@]}"
echo "Done: build $NUM is in $GROUP."
