#!/usr/bin/env node

/**
 * Snapshot Persistence Helper Script
 * Saves a V2 DailyAnalysis snapshot to public/snapshots/ and updates public/snapshots/index.json manifest.
 *
 * Usage:
 *   node trading-terminal/scripts/save-snapshot.cjs <path-to-snapshot.json>
 */

const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const snapshotsDir = path.join(projectRoot, 'public', 'snapshots')
const manifestPath = path.join(snapshotsDir, 'index.json')

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Error: Please provide a path to a snapshot JSON file.')
    console.error('Usage: node trading-terminal/scripts/save-snapshot.cjs <path-to-snapshot.json>')
    process.exit(1)
  }

  const inputPath = path.resolve(args[0])
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found at ${inputPath}`)
    process.exit(1)
  }

  let snapshot
  try {
    const content = fs.readFileSync(inputPath, 'utf8')
    snapshot = JSON.parse(content)
  } catch (err) {
    console.error(`Error parsing JSON from ${inputPath}:`, err.message)
    process.exit(1)
  }

  if (!snapshot.date || !snapshot.symbol || !snapshot.big_money_analysis) {
    console.error('Error: Invalid snapshot format. Required fields: date, symbol, big_money_analysis.')
    process.exit(1)
  }

  const date = String(snapshot.date).trim()
  const symbol = String(snapshot.symbol).trim().toUpperCase()
  const market = String(snapshot.market || 'FOREX').trim().toUpperCase()

  const snapshotFilename = `${date}-${symbol.toLowerCase()}.json`
  const targetSnapshotPath = path.join(snapshotsDir, snapshotFilename)
  const relativeFilePath = `/snapshots/${snapshotFilename}`

  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true })
  }

  fs.writeFileSync(targetSnapshotPath, JSON.stringify(snapshot, null, 2), 'utf8')
  console.log(`✓ Saved snapshot to: ${targetSnapshotPath}`)

  let manifest = []
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (!Array.isArray(manifest)) manifest = []
    } catch {
      manifest = []
    }
  }

  manifest = manifest.filter((entry) => !(entry.symbol === symbol && entry.date === date))

  manifest.unshift({
    date,
    symbol,
    market,
    file: relativeFilePath,
  })

  manifest.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`✓ Updated manifest index at: ${manifestPath}`)
}

main()
