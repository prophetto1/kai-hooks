#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function repoSlug(repoRoot) {
  return path.basename(path.resolve(repoRoot)).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

function normalizePath(value) {
  return value.replace(/\\/g, '/')
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function main() {
  const repoRoot = readOption('--repo-root')
  const token = readOption('--token')
  const slot = Number.parseInt(readOption('--slot', ''), 10)
  if (!repoRoot) throw new Error('--repo-root is required')
  if (!token) throw new Error('--token is required')
  if (!Number.isFinite(slot) || slot <= 0) throw new Error('--slot must be a positive integer')

  const stateRoot = readOption(
    '--state-root',
    path.resolve(SCRIPT_DIR, '..', '.state', 'auth-slot-lease'),
  )
  const leaseFile = path.join(stateRoot, repoSlug(repoRoot), 'leases', `slot-${slot}.json`)
  const lease = await readJson(leaseFile)
  if (!lease) {
    console.log(JSON.stringify({ released: false, reason: 'missing', leaseFile: normalizePath(leaseFile) }))
    return
  }
  if (lease.token !== token) {
    console.log(JSON.stringify({ released: false, reason: 'token_mismatch', leaseFile: normalizePath(leaseFile) }))
    return
  }

  await fs.rm(leaseFile, { force: true })
  console.log(JSON.stringify({ released: true, leaseFile: normalizePath(leaseFile) }))
}

main().catch((error) => {
  console.error(`auth slot release failed: ${error.message}`)
  process.exitCode = 1
})
