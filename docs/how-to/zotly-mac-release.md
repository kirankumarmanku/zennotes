# Build a signed Mac app

This fork's Mac app is signed the way ZotlyApp's `scripts/release-macos.sh`
signs Zotly: a **Developer ID Application** certificate, the hardened runtime,
notarization with the **App Store Connect API key** (`.p8`) through
`notarytool`, and the ticket stapled to the app and to the `.dmg`. It is direct
distribution, not the Mac App Store, so the `.dmg` opens on any Mac with no
Gatekeeper warning.

The build uses `apps/desktop/electron-builder.zotly.cjs`: upstream's settings
with its own bundle identifier (`com.kirankumarmanku.zennotes`) and this fork's
releases as the update feed, so the app never tries to install an upstream
build signed by another team.

## On your Mac

The same certificate and key ZotlyApp's release script uses:

- the Developer ID Application certificate in the login keychain;
- `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`;
- Xcode (the Quick Look and Share extensions are compiled with it).

```bash
npm ci
ASC_ISSUER_ID=<issuer id> ./tooling/scripts/zotly-mac-release.sh
```

The `.dmg` is in `dist/`. `ZOTLY_ARCH=x64` or `both` builds for Intel Macs too;
`ZOTLY_UNSIGNED=1` makes an ad-hoc signed app with no certificate, to try the
packaging. The first signing shows a keychain prompt for the private key:
choose **Always Allow**.

## In GitHub Actions

`.github/workflows/zotly-mac.yml` runs the same script on a macOS runner.

1. Turn Actions on for this fork (Actions tab, "I understand my workflows").
2. Export the Developer ID Application certificate from Keychain Access
   (My Certificates, right-click, Export, `.p12`, with a password you choose).
3. Add the secrets and variables:

   ```bash
   R=kirankumarmanku/zennotes
   base64 -i ~/Desktop/developer-id.p12 | gh secret set DEVELOPER_ID_CERT_P12_BASE64 -R $R
   gh secret set DEVELOPER_ID_CERT_PASSWORD -R $R    # prompts: the .p12 password
   base64 -i ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8 | gh secret set ASC_KEY_P8_BASE64 -R $R
   gh variable set ASC_KEY_ID -R $R --body <key id>
   gh variable set ASC_ISSUER_ID -R $R --body <issuer id>
   rm ~/Desktop/developer-id.p12
   ```

   `ASC_KEY_P8_BASE64`, `ASC_KEY_ID` and `ASC_ISSUER_ID` hold the same values
   as in the iPhone fork's TestFlight workflow. The Apple Distribution
   certificate that workflow uses cannot sign a Mac app outside the App Store,
   so the Developer ID one is a secret of its own.

4. Run **Zotly Mac** from the Actions tab. Each run publishes a release on
   this fork, the way ZotlyApp publishes Zotly on its public releases repo,
   and marks it latest, so these links always download the newest build:

   - Apple silicon: https://github.com/kirankumarmanku/zennotes/releases/latest/download/ZenNotes-mac-arm64.dmg
   - Intel: https://github.com/kirankumarmanku/zennotes/releases/latest/download/ZenNotes-mac-x64.dmg

   The fork is public, so anyone with a link can download the app. Untick
   **Publish** to keep a run's build as the `zotly-mac` workflow artifact
   only. A pushed `zotly-mac-v<anything>` tag publishes under that tag.

The app's version is `apps/desktop/package.json`'s; the build number
(`CFBundleVersion`) is the commit count, as in ZotlyApp. The in-app updater
offers a release only when its version is higher than the installed one.
