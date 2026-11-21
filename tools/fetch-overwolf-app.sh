#!/usr/bin/env bash
# Install any Overwolf app by its uid: classic apps (.opk) from the store
# catalog, otherwise ow-electron apps from their update feed.
#
#   tools/fetch-overwolf-app.sh <overwolf app uid>
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
uid="${1:-}"
if [[ ! "$uid" =~ ^[a-z]{40}$ ]]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
"$here/fetch-opk-app.sh" "$uid"
code=$?
[[ $code -eq 3 ]] || exit $code
echo "not a classic app, trying Overwolf's ow-electron update feed"
exec "$here/fetch-ow-electron-app.sh" "$uid"
