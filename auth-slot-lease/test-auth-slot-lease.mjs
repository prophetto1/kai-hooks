#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const CLAIM = path.join(SCRIPT_DIR, 'claim-auth-slot.mjs')
const RELEASE = path.join(SCRIPT_DIR, 'release-auth-slot.mjs')
const REPO_ROOT = 'E:/jwc-global'

function fakeEnv() {
  return {
    ...process.env,
    JWC_AGENT_SLOT_COUNT: '2',
    JWC_AGENT_SLOT_1_EMAIL: 'testid2@jwctest.com',
    JWC_AGENT_SLOT_1_PASSWORD: 'fake-password-slot-1',
    JWC_AGENT_SLOT_1_USER_ID: 'user-slot-1',
    JWC_AGENT_SLOT_2_EMAIL: 'testid3@jwctest.com',
    JWC_AGENT_SLOT_2_PASSWORD: 'fake-password-slot-2',
    JWC_AGENT_SLOT_2_USER_ID: 'user-slot-2',
  }
}

function runNode(script, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        env: options.env ?? fakeEnv(),
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        })
      },
    )
  })
}

function parseJson(stdout) {
  assert.ok(stdout, 'expected JSON stdout')
  return JSON.parse(stdout)
}

async function testParallelClaims(stateRoot) {
  const args = ['--repo-root', REPO_ROOT, '--state-root', stateRoot]
  const [first, second] = await Promise.all([
    runNode(CLAIM, args),
    runNode(CLAIM, args),
  ])
  assert.equal(first.code, 0, first.stderr)
  assert.equal(second.code, 0, second.stderr)
  const one = parseJson(first.stdout)
  const two = parseJson(second.stdout)
  assert.notEqual(one.slot, two.slot)

  const third = await runNode(CLAIM, args)
  assert.notEqual(third.code, 0, 'third claim should fail when the two-slot pool is exhausted')

  const releaseOne = await runNode(RELEASE, [
    '--repo-root',
    REPO_ROOT,
    '--state-root',
    stateRoot,
    '--slot',
    String(one.slot),
    '--token',
    one.token,
  ])
  assert.equal(releaseOne.code, 0, releaseOne.stderr)
  assert.equal(parseJson(releaseOne.stdout).released, true)

  const releaseTwo = await runNode(RELEASE, [
    '--repo-root',
    REPO_ROOT,
    '--state-root',
    stateRoot,
    '--slot',
    String(two.slot),
    '--token',
    two.token,
  ])
  assert.equal(releaseTwo.code, 0, releaseTwo.stderr)
  assert.equal(parseJson(releaseTwo.stdout).released, true)
}

async function testStaleLeaseReclaim(stateRoot) {
  const leaseDir = path.join(stateRoot, 'jwc-global', 'leases')
  await fs.mkdir(leaseDir, { recursive: true })
  await fs.writeFile(
    path.join(leaseDir, 'slot-1.json'),
    `${JSON.stringify(
      {
        slot: 1,
        email: 'testid2@jwctest.com',
        repoRoot: REPO_ROOT,
        pid: 999999,
        sessionId: 'stale-test',
        claimedAt: '2000-01-01T00:00:00.000Z',
        expiresAt: '2000-01-01T01:00:00.000Z',
        token: 'stale-token',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const claimed = await runNode(CLAIM, ['--repo-root', REPO_ROOT, '--state-root', stateRoot])
  assert.equal(claimed.code, 0, claimed.stderr)
  const claim = parseJson(claimed.stdout)
  assert.equal(claim.slot, 1)
  await runNode(RELEASE, [
    '--repo-root',
    REPO_ROOT,
    '--state-root',
    stateRoot,
    '--slot',
    '1',
    '--token',
    claim.token,
  ])
}

async function testReleaseOwnership(stateRoot) {
  const claimed = await runNode(CLAIM, ['--repo-root', REPO_ROOT, '--state-root', stateRoot])
  assert.equal(claimed.code, 0, claimed.stderr)
  const claim = parseJson(claimed.stdout)

  const wrongRelease = await runNode(RELEASE, [
    '--repo-root',
    REPO_ROOT,
    '--state-root',
    stateRoot,
    '--slot',
    String(claim.slot),
    '--token',
    'wrong-token',
  ])
  assert.equal(wrongRelease.code, 0, wrongRelease.stderr)
  assert.equal(parseJson(wrongRelease.stdout).released, false)

  const leaseFile = path.join(stateRoot, 'jwc-global', 'leases', `slot-${claim.slot}.json`)
  await fs.access(leaseFile)

  const rightRelease = await runNode(RELEASE, [
    '--repo-root',
    REPO_ROOT,
    '--state-root',
    stateRoot,
    '--slot',
    String(claim.slot),
    '--token',
    claim.token,
  ])
  assert.equal(parseJson(rightRelease.stdout).released, true)
  await assert.rejects(fs.access(leaseFile), { code: 'ENOENT' })
}

async function main() {
  const tempRoot = path.join(os.tmpdir(), `auth-slot-lease-test-${process.pid}`)
  await fs.rm(tempRoot, { recursive: true, force: true })
  try {
    await testParallelClaims(tempRoot)
    await fs.rm(tempRoot, { recursive: true, force: true })
    await testStaleLeaseReclaim(tempRoot)
    await fs.rm(tempRoot, { recursive: true, force: true })
    await testReleaseOwnership(tempRoot)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
  console.log('auth_slot_lease_tests_ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
