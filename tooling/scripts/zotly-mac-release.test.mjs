import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { refreshDmgEntries } from './zotly-mac-feed.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { notarizeCredentials } = require(path.join(root, 'apps/desktop/scripts/notarize.cjs'))
const zotlyConfig = require(path.join(root, 'apps/desktop/electron-builder.zotly.cjs'))
const pkg = require(path.join(root, 'apps/desktop/package.json'))

describe('notarizeCredentials', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zotly-notarize-'))
  const key = path.join(dir, 'AuthKey_TEST.p8')
  writeFileSync(key, 'not a real key')

  it('uses the App Store Connect key, the way ZotlyApp notarizes', () => {
    assert.deepEqual(
      notarizeCredentials({ APPLE_API_KEY: key, APPLE_API_KEY_ID: 'TEST', APPLE_API_ISSUER: 'issuer' }),
      { appleApiKey: key, appleApiKeyId: 'TEST', appleApiIssuer: 'issuer' }
    )
  })

  it('prefers the key over an Apple ID', () => {
    const credentials = notarizeCredentials({
      APPLE_API_KEY: key,
      APPLE_API_KEY_ID: 'TEST',
      APPLE_API_ISSUER: 'issuer',
      APPLE_ID: 'someone@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'pw',
      APPLE_TEAM_ID: 'TEAM'
    })
    assert.equal(credentials.appleApiKey, key)
    assert.equal(credentials.appleId, undefined)
  })

  it('keeps upstream\'s Apple ID notarization', () => {
    assert.deepEqual(
      notarizeCredentials({ APPLE_ID: 'someone@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' }),
      { appleId: 'someone@example.com', appleIdPassword: 'pw', teamId: 'TEAM' }
    )
  })

  it('refuses a half-set key instead of skipping notarization', () => {
    assert.throws(() => notarizeCredentials({ APPLE_API_KEY: key }), /APPLE_API_KEY_ID, APPLE_API_ISSUER/)
  })

  it('refuses a key path that does not exist', () => {
    assert.throws(
      () => notarizeCredentials({ APPLE_API_KEY: path.join(dir, 'missing.p8'), APPLE_API_KEY_ID: 'X', APPLE_API_ISSUER: 'Y' }),
      /does not exist/
    )
  })

  it('returns null with nothing set', () => {
    assert.equal(notarizeCredentials({}), null)
  })

  it('cleans up', () => rmSync(dir, { recursive: true, force: true }))
})

describe('electron-builder.zotly.cjs', () => {
  it('keeps upstream\'s settings and hardened runtime', () => {
    assert.equal(zotlyConfig.productName, pkg.build.productName)
    assert.equal(zotlyConfig.afterSign, 'scripts/notarize.cjs')
    assert.equal(zotlyConfig.afterPack, pkg.build.afterPack)
    assert.equal(zotlyConfig.mac.hardenedRuntime, true)
    assert.equal(zotlyConfig.mac.entitlements, pkg.build.mac.entitlements)
    assert.deepEqual(zotlyConfig.mac.target, pkg.build.mac.target)
    assert.equal(zotlyConfig.mac.notarize, false)
  })

  it('has its own bundle id, update feed and a signed .dmg', () => {
    assert.equal(zotlyConfig.appId, 'com.kirankumarmanku.zennotes')
    assert.notEqual(zotlyConfig.appId, pkg.build.appId)
    assert.deepEqual(zotlyConfig.publish, [{ provider: 'github', owner: 'kirankumarmanku', repo: 'zennotes' }])
    assert.equal(zotlyConfig.dmg.sign, true)
  })

  it('signs nothing with ZOTLY_UNSIGNED=1', () => {
    const file = path.join(root, 'apps/desktop/electron-builder.zotly.cjs')
    delete require.cache[file]
    process.env.ZOTLY_UNSIGNED = '1'
    try {
      const unsigned = require(file)
      assert.equal(unsigned.mac.identity, null)
      assert.equal(unsigned.dmg.sign, false)
    } finally {
      delete process.env.ZOTLY_UNSIGNED
      delete require.cache[file]
    }
    assert.equal('identity' in require(file).mac, false)
  })

  it('takes the build number as a string', () => {
    const file = path.join(root, 'apps/desktop/electron-builder.zotly.cjs')
    delete require.cache[file]
    process.env.ZOTLY_BUILD_NUMBER = '1234'
    try {
      assert.equal(require(file).buildVersion, '1234')
    } finally {
      delete process.env.ZOTLY_BUILD_NUMBER
      delete require.cache[file]
    }
    assert.equal('buildVersion' in require(file), false)
  })

  it('leaves package.json alone', () => {
    assert.equal(pkg.build.appId, 'com.adibhanna.zennotes')
    assert.equal(pkg.build.publish[0].owner, 'ZenNotes')
  })
})

describe('refreshDmgEntries', () => {
  const feed = [
    'version: 2.93.0',
    'files:',
    '  - url: ZenNotes-2.93.0-mac-arm64.zip',
    '    sha512: ZIPSHA',
    '    size: 100',
    '  - url: ZenNotes-2.93.0-mac-arm64.dmg',
    '    sha512: OLDDMG',
    '    size: 200',
    'path: ZenNotes-2.93.0-mac-arm64.zip',
    'sha512: ZIPSHA',
    "releaseDate: '2026-11-27T21:00:00.000Z'",
    ''
  ].join('\n')

  it('rewrites only the .dmg entries', () => {
    const seen = []
    const out = refreshDmgEntries(feed, (name) => {
      seen.push(name)
      return { sha512: 'NEWDMG', size: 201 }
    })
    assert.deepEqual(seen, ['ZenNotes-2.93.0-mac-arm64.dmg'])
    assert.match(out, /dmg\n {4}sha512: NEWDMG\n {4}size: 201\n/)
    assert.match(out, /zip\n {4}sha512: ZIPSHA\n {4}size: 100\n/)
    assert.match(out, /^sha512: ZIPSHA$/m)
    assert.equal(out.split('\n').length, feed.split('\n').length)
  })

  it('leaves a feed with no .dmg as it was', () => {
    const zipOnly = feed.replace(/ {2}- url: [^\n]*dmg\n[^\n]*\n[^\n]*\n/, '')
    assert.equal(refreshDmgEntries(zipOnly, () => assert.fail('no dmg')), zipOnly)
  })
})
