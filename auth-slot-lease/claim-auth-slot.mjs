#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DEFAULT_TTL_SECONDS = 2 * 60 * 60
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

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`missing ${name}; load repo auth secrets before claiming a slot`)
  }
  return value
}

function ownerPid() {
  const raw = readOption('--owner-pid', process.env.JWC_AGENT_LEASE_OWNER_PID ?? String(process.ppid))
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('--owner-pid must be a positive integer')
  }
  return parsed
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function isFresh(lease) {
  const expiresAt = Date.parse(String(lease?.expiresAt ?? ''))
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function removeStaleLease(file) {
  await fs.rm(file, { force: true })
}

function slotFromEnv(slot) {
  return {
    slot,
    email: requiredEnv(`JWC_AGENT_SLOT_${slot}_EMAIL`),
    password: requiredEnv(`JWC_AGENT_SLOT_${slot}_PASSWORD`),
    userId: requiredEnv(`JWC_AGENT_SLOT_${slot}_USER_ID`),
  }
}

async function tryClaim({ leaseFile, repoRoot, slotInfo, ttlSeconds }) {
  const now = new Date()
  const lease = {
    slot: slotInfo.slot,
    email: slotInfo.email,
    repoRoot: normalizePath(path.resolve(repoRoot)),
    pid: ownerPid(),
    sessionId:
      process.env.CODEX_SESSION_ID ??
      process.env.CLAUDE_SESSION_ID ??
      process.env.CURSOR_SESSION_ID ??
      'unknown',
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    token: crypto.randomBytes(18).toString('hex'),
    host: os.hostname(),
  }

  try {
    const handle = await fs.open(leaseFile, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return {
      slot: slotInfo.slot,
      email: slotInfo.email,
      userId: slotInfo.userId,
      repoRoot: lease.repoRoot,
      leaseFile: normalizePath(leaseFile),
      token: lease.token,
      expiresAt: lease.expiresAt,
      env: {
        JWC_AGENT_SLOT: String(slotInfo.slot),
        JWC_AGENT_EMAIL: slotInfo.email,
        JWC_AGENT_PASSWORD: slotInfo.password,
        JWC_AGENT_USER_ID: slotInfo.userId,
      },
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  const existing = await readJson(leaseFile)
  if (existing && isFresh(existing) && isPidAlive(Number(existing.pid))) {
    return null
  }

  await removeStaleLease(leaseFile)
  return tryClaim({ leaseFile, repoRoot, slotInfo, ttlSeconds })
}

async function main() {
  const repoRoot = readOption('--repo-root')
  if (!repoRoot) throw new Error('--repo-root is required')

  const ttlSeconds = Number.parseInt(readOption('--ttl-seconds', String(DEFAULT_TTL_SECONDS)), 10)
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('--ttl-seconds must be a positive integer')
  }

  const stateRoot = readOption(
    '--state-root',
    path.resolve(SCRIPT_DIR, '..', '.state', 'auth-slot-lease'),
  )
  const slotCount = Number.parseInt(requiredEnv('JWC_AGENT_SLOT_COUNT'), 10)
  if (!Number.isFinite(slotCount) || slotCount <= 0) {
    throw new Error('JWC_AGENT_SLOT_COUNT must be a positive integer')
  }

  const leaseDir = path.join(stateRoot, repoSlug(repoRoot), 'leases')
  await fs.mkdir(leaseDir, { recursive: true })

  for (let slot = 1; slot <= slotCount; slot += 1) {
    const slotInfo = slotFromEnv(slot)
    const result = await tryClaim({
      leaseFile: path.join(leaseDir, `slot-${slot}.json`),
      repoRoot,
      slotInfo,
      ttlSeconds,
    })
    if (result) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
  }

  throw new Error(`no available auth slots for ${normalizePath(path.resolve(repoRoot))}`)
}

main().catch((error) => {
  console.error(`auth slot claim failed: ${error.message}`)
  process.exitCode = 1
})
