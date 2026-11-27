const fs = require('node:fs')
const path = require('node:path')

/**
 * The credentials notarytool signs in with, from the environment.
 *
 * Two kinds are accepted:
 * - an App Store Connect API key (APPLE_API_KEY, the path of the .p8, with
 *   APPLE_API_KEY_ID and APPLE_API_ISSUER), the way ZotlyApp's release script
 *   notarizes, under the names electron-builder itself reads;
 * - an Apple ID (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID), the
 *   way upstream's release workflow does.
 *
 * The key wins when both are set. A half-set key is an error rather than a
 * quiet fall back to the Apple ID, because it is always a typo.
 */
function notarizeCredentials(env = process.env) {
  const keyNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  if (keyNames.some((name) => env[name])) {
    const missing = keyNames.filter((name) => !env[name])
    if (missing.length > 0) {
      throw new Error(`App Store Connect key notarization needs ${missing.join(', ')} as well.`)
    }
    if (!fs.existsSync(env.APPLE_API_KEY)) {
      throw new Error(`APPLE_API_KEY points at ${env.APPLE_API_KEY}, which does not exist.`)
    }
    return {
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER
    }
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID
    }
  }
  return null
}

async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return

  const requireSigning = process.env.REQUIRE_MAC_SIGNING === 'true'
  const credentials = notarizeCredentials()

  if (!credentials) {
    if (requireSigning) {
      throw new Error(
        'Missing Apple notarization credentials. Set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, ' +
          'or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.'
      )
    }
    console.log('[notarize] Skipping macOS notarization because Apple credentials are not configured.')
    return
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  console.log(
    `[notarize] Notarizing ${appPath} with ${credentials.appleApiKey ? 'an App Store Connect key' : 'an Apple ID'}`
  )
  const { notarize } = require('@electron/notarize')
  await notarize({ appPath, ...credentials })
}

module.exports = notarizeApp
module.exports.default = notarizeApp
module.exports.notarizeCredentials = notarizeCredentials
