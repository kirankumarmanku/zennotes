// electron-builder settings for Kiran's own signed Mac build of this fork.
//
// The same package.json "build" block, with three changes:
//
// - appId: its own bundle identifier, so this build and an upstream ZenNotes
//   install never share one (macOS ties privacy prompts, keychain access and
//   "Open with" choices to it).
// - publish: the fork's own releases, so the in-app updater never fetches an
//   upstream build, which carries another team's signature and which
//   Squirrel.Mac refuses to install over this one.
// - dmg.sign: the disk image carries the Developer ID signature too, so the
//   release script can notarize and staple it, as ZotlyApp's does.
//
// Used by tooling/scripts/zotly-mac-release.sh and the "Zotly Mac" workflow.
const pkg = require('./package.json')

const base = pkg.build
// ZOTLY_UNSIGNED=1 (tooling/scripts/zotly-mac-release.sh): ad-hoc signed app, unsigned .dmg.
const unsigned = process.env.ZOTLY_UNSIGNED === '1'
const owner = process.env.ZOTLY_RELEASE_OWNER || 'kirankumarmanku'
const repo = process.env.ZOTLY_RELEASE_REPO || 'zennotes'

module.exports = {
  ...base,
  appId: process.env.ZOTLY_MAC_APP_ID || 'com.kirankumarmanku.zennotes',
  // CFBundleVersion: the release script passes the commit count, as ZotlyApp's does.
  ...(process.env.ZOTLY_BUILD_NUMBER ? { buildVersion: String(process.env.ZOTLY_BUILD_NUMBER) } : {}),
  publish: [{ provider: 'github', owner, repo }],
  mac: {
    ...base.mac,
    // Notarization runs in scripts/notarize.cjs (afterSign), with the App
    // Store Connect key; electron-builder's own pass stays off.
    notarize: false,
    ...(unsigned ? { identity: null } : {})
  },
  dmg: {
    ...(base.dmg || {}),
    sign: !unsigned
  }
}
