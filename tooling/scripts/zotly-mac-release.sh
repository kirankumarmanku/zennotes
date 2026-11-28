#!/bin/bash
# Kiran's ZenNotes for macOS: build, sign, notarize and staple a Developer ID release.
#
# Signed the way ZotlyApp's scripts/release-macos.sh signs Zotly: a "Developer ID Application"
# certificate, the hardened runtime, notarization with the App Store Connect API key (.p8) through
# notarytool, and the notarization ticket stapled to the app and to the .dmg. That is direct
# distribution, not the Mac App Store: the .dmg opens on any Mac with no Gatekeeper warning.
#
# On your Mac (the certificate in the login keychain, the key where ZotlyApp's script reads it):
#
#   ASC_ISSUER_ID=<issuer id> ./tooling/scripts/zotly-mac-release.sh
#
#   ASC_KEY_ID      defaults to the one AuthKey_<id>.p8 in ~/.appstoreconnect/private_keys
#   ASC_KEY_P8      the .p8 path, if it lives somewhere else
#   ZOTLY_ARCH      arm64 (default on Apple silicon), x64, or both
#   ZOTLY_BUILD_NUMBER  CFBundleVersion; defaults to the commit count
#   ZOTLY_UNSIGNED=1    ad-hoc signed bundle only: no certificate, no notarization
#
# In GitHub Actions (.github/workflows/zotly-mac.yml) the certificate comes from CSC_LINK and
# CSC_KEY_PASSWORD instead, which electron-builder imports into a temporary keychain.
#
# The first signing on your Mac shows a keychain prompt for the Developer ID private key; choose
# "Always Allow", or codesign waits on that dialog.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
OUT="$ROOT/dist"
cd "$ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
	echo "This builds the Mac app and has to run on a Mac." >&2
	exit 1
fi

UNSIGNED="${ZOTLY_UNSIGNED:-0}"
export ZOTLY_BUILD_NUMBER="${ZOTLY_BUILD_NUMBER:-$(git -C "$ROOT" rev-list --count HEAD)}"
BUILD_NUMBER="$ZOTLY_BUILD_NUMBER"
case "${ZOTLY_ARCH:-$(uname -m)}" in
	arm64) ARCH_FLAGS=(--arm64) ;;
	x86_64 | x64) ARCH_FLAGS=(--x64) ;;
	both | universal-pair) ARCH_FLAGS=(--arm64 --x64) ;;
	*) echo "ZOTLY_ARCH must be arm64, x64 or both." >&2; exit 1 ;;
esac

# --- preflight ------------------------------------------------------------
# `|| true`: with `set -e -o pipefail`, grep exiting 1 on no match would end the script before
# the message that says what to do.
if [ "$UNSIGNED" = "1" ]; then
	echo "==> ZOTLY_UNSIGNED=1: ad-hoc signature, no notarization."
	export CSC_IDENTITY_AUTO_DISCOVERY=false
	unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME
	unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
	export ZOTLY_UNSIGNED=1
else
	if [ -n "${CSC_LINK:-}" ]; then
		[ -n "${CSC_KEY_PASSWORD:-}" ] || { echo "CSC_LINK is set but CSC_KEY_PASSWORD is not." >&2; exit 1; }
		echo "==> Signing identity: the Developer ID certificate in CSC_LINK"
	else
		IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
			| grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/' || true)"
		if [ -z "$IDENTITY" ]; then
			echo "No 'Developer ID Application' certificate in the keychain." >&2
			echo "Create one: Xcode > Settings > Accounts > Manage Certificates > + >" >&2
			echo "'Developer ID Application'  (Account Holder only), then re-run." >&2
			exit 1
		fi
		echo "==> Signing identity: $IDENTITY"
		export CSC_NAME="${IDENTITY#Developer ID Application: }"
	fi

	KEYS_DIR="$HOME/.appstoreconnect/private_keys"
	if [ -z "${ASC_KEY_ID:-}" ] && [ -z "${ASC_KEY_P8:-}" ]; then
		shopt -s nullglob
		found=("$KEYS_DIR"/AuthKey_*.p8)
		shopt -u nullglob
		if [ "${#found[@]}" -eq 1 ]; then
			ASC_KEY_ID="$(basename "${found[0]}" .p8)"; ASC_KEY_ID="${ASC_KEY_ID#AuthKey_}"
		else
			echo "Set ASC_KEY_ID: ${#found[@]} App Store Connect keys in $KEYS_DIR, need exactly one." >&2
			exit 1
		fi
	fi
	ASC_KEY_P8="${ASC_KEY_P8:-$KEYS_DIR/AuthKey_${ASC_KEY_ID}.p8}"
	if [ -z "${ASC_KEY_ID:-}" ]; then
		ASC_KEY_ID="$(basename "$ASC_KEY_P8" .p8)"; ASC_KEY_ID="${ASC_KEY_ID#AuthKey_}"
	fi
	[ -f "$ASC_KEY_P8" ] || { echo "Missing App Store Connect key for notarization: $ASC_KEY_P8" >&2; exit 1; }
	if [ -z "${ASC_ISSUER_ID:-}" ]; then
		echo "Set ASC_ISSUER_ID to the issuer id of that App Store Connect key." >&2
		echo "It is the ASC_ISSUER_ID ZotlyApp's scripts/release-macos.sh and the iPhone fork's" >&2
		echo "TestFlight workflow use (App Store Connect > Users and Access > Integrations)." >&2
		exit 1
	fi
	# The names electron-builder and scripts/notarize.cjs read.
	export APPLE_API_KEY="$ASC_KEY_P8" APPLE_API_KEY_ID="$ASC_KEY_ID" APPLE_API_ISSUER="$ASC_ISSUER_ID"
	unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
	export REQUIRE_MAC_SIGNING=true
fi

VERSION="$(node -p "require('$DESKTOP/package.json').version")"
echo "==> ZenNotes $VERSION (build $BUILD_NUMBER) for ${ARCH_FLAGS[*]}"

# --- build ----------------------------------------------------------------
# Typecheck and build. The test suite runs in CI on every push to main, and a release build
# should not wait 20 minutes on it a second time.
echo "==> Building…"
npm run typecheck --workspace @zennotes/desktop
npm run build --workspace @zennotes/desktop

# Stale artifacts from an earlier version would be notarized and uploaded with this one.
rm -f "$OUT"/*.dmg "$OUT"/*.zip "$OUT"/*.blockmap "$OUT"/latest-mac.yml

# --- package, sign, notarize the app --------------------------------------
# electron-builder signs inside-out with the hardened runtime and a secure timestamp
# (mac.hardenedRuntime), the Quick Look and Share extensions are signed in build/after-pack.js,
# and scripts/notarize.cjs notarizes and staples the app before the .dmg and .zip are made.
echo "==> Packaging and signing…"
(
	cd "$DESKTOP"
	npx electron-builder --mac "${ARCH_FLAGS[@]}" \
		--config electron-builder.zotly.cjs \
		--publish never
)

shopt -s nullglob
DMGS=("$OUT"/*.dmg)
APPS=("$OUT"/mac*/*.app)
shopt -u nullglob
[ "${#DMGS[@]}" -gt 0 ] || { echo "electron-builder made no .dmg in $OUT" >&2; exit 1; }

if [ "$UNSIGNED" = "1" ]; then
	echo
	for app in "${APPS[@]}"; do echo "✓ $app  (unsigned test build)"; done
	exit 0
fi

for app in "${APPS[@]}"; do
	codesign --verify --deep --strict --verbose=2 "$app"
	xcrun stapler validate "$app"
done

# --- notarize the .dmg ----------------------------------------------------
# As ZotlyApp does: the disk image is notarized and stapled too, so it opens without a warning
# even before the app inside is looked at, and offline.
for dmg in "${DMGS[@]}"; do
	echo "==> Notarizing $(basename "$dmg")…"
	codesign --verify --verbose=2 "$dmg"
	xcrun notarytool submit "$dmg" \
		--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" \
		--wait
	xcrun stapler staple "$dmg"
	xcrun stapler validate "$dmg"
	spctl --assess --type open --context context:primary-signature -vv "$dmg" || true
done

# Stapling changed each .dmg, so its blockmap and its size and sha512 in latest-mac.yml are stale.
# The updater downloads the .zip, whose entries are untouched; put the .dmg entries right and drop
# the .dmg blockmaps rather than serve wrong ones.
rm -f "$OUT"/*.dmg.blockmap
if [ -f "$OUT/latest-mac.yml" ]; then
	node "$ROOT/tooling/scripts/zotly-mac-feed.mjs" "$OUT/latest-mac.yml"
fi

echo
for dmg in "${DMGS[@]}"; do echo "✓ $dmg"; done
echo "  Signed with Developer ID, notarized and stapled."
