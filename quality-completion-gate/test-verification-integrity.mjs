import assert from 'node:assert/strict';
import {
  isFraudulentVerificationCommand,
  nextFraudStrike,
  verificationFraudBlock,
} from './verification-integrity.mjs';

assert.equal(isFraudulentVerificationCommand('node scripts/dev/ui-snapshot.mjs'), true);
assert.equal(isFraudulentVerificationCommand('node scripts/dev/ui-snapshot-route.mjs'), true);
assert.equal(isFraudulentVerificationCommand('node scripts/dev/ui-snapshot-live.mjs'), false);
assert.equal(
  isFraudulentVerificationCommand('node scripts/dev/verify-platform-visual-manifest-live.mjs'),
  false,
);

assert.equal(nextFraudStrike(0), 1);
assert.equal(nextFraudStrike(2), 3);
assert.equal(nextFraudStrike(3), 3);

const block = verificationFraudBlock('Mocked run detected.', 2);
assert.match(block, /VERIFICATION FRAUD/);
assert.match(block, /Session fraud strike: 2\/3/);
assert.match(block, /Fabricating verification is fraud/);

console.log('verification-integrity tests passed');
