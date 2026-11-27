#!/usr/bin/env node
// Bring the .dmg entries of electron-builder's latest-mac.yml up to date after the release script
// stapled each .dmg, which changes its bytes: the sha512 and size electron-builder wrote are of the
// unstapled image. The .zip entries, which the updater downloads, are left exactly as they are.
//
//   node tooling/scripts/zotly-mac-feed.mjs dist/latest-mac.yml
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The feed text with every `.dmg` file entry's sha512 and size replaced by
 * `describe(name)`. Line based, like the rest of this repository's feed
 * handling (apps/desktop/src/main/update-feed.ts): the document is
 * electron-builder's own flat output, not arbitrary YAML.
 */
export function refreshDmgEntries(feed, describe) {
  const lines = feed.split('\n')
  let current = null
  for (let i = 0; i < lines.length; i += 1) {
    const url = /^(\s*)- url:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i])
    if (url) {
      current = url[2].endsWith('.dmg') ? describe(url[2]) : null
      continue
    }
    if (!current) continue
    if (!/^\s{2,}\S/.test(lines[i]) || /^\s*-\s/.test(lines[i])) {
      current = null
      continue
    }
    lines[i] = lines[i]
      .replace(/^(\s*sha512:\s*).*$/, `$1${current.sha512}`)
      .replace(/^(\s*size:\s*).*$/, `$1${current.size}`)
  }
  return lines.join('\n')
}

export function describeFile(file) {
  return {
    sha512: createHash('sha512').update(readFileSync(file)).digest('base64'),
    size: statSync(file).size
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const feedPath = process.argv[2]
  if (!feedPath) {
    console.error('usage: zotly-mac-feed.mjs <latest-mac.yml>')
    process.exit(2)
  }
  const dir = path.dirname(feedPath)
  const before = readFileSync(feedPath, 'utf8')
  const after = refreshDmgEntries(before, (name) => describeFile(path.join(dir, name)))
  writeFileSync(feedPath, after)
  console.log(`==> ${path.basename(feedPath)}: .dmg entries ${before === after ? 'unchanged' : 'updated'}`)
}
