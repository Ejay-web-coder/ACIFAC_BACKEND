// Unit tests for the member ID card rules (no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInStatus, idCardQrText, parseIdCardCode } from '../src/services/idCards.js';
import { nowClock } from '../src/utils/dates.js';

const CODE = '7f3a9c0e1b2d4f6a8c0e2b4d6f8a0c1e';

test('member ID: the QR holds ACIFAC: and the code only, in capitals (the compact QR mode)', () => {
  assert.equal(idCardQrText(CODE), `ACIFAC:${CODE.toUpperCase()}`);
  assert.match(idCardQrText(CODE), /^[0-9A-Z:]+$/);
  assert.equal(parseIdCardCode(idCardQrText(CODE)), CODE);
});

test('member ID: a scanned code is read with or without ACIFAC:, in any case, spaces trimmed', () => {
  assert.equal(parseIdCardCode(CODE), CODE);
  assert.equal(parseIdCardCode(` acifac:${CODE.toUpperCase()} \n`), CODE);
  assert.equal(parseIdCardCode(`ACIFAC: ${CODE}`), CODE);
});

test('member ID: anything else is not an ACIFAC member ID', () => {
  for (const value of ['', 'ACIFAC:', `ACIFAC:${CODE.slice(1)}`, `ACIFAC:${CODE}0`, `ACIFAC:${CODE.replace('7', 'g')}`, 'https://example.com', `XACIFAC:${CODE}`, null, undefined, 123]) {
    assert.equal(parseIdCardCode(value), null, String(value));
  }
});

test('scan check-in: present up to the start time, late after it (no grace period)', () => {
  assert.equal(checkInStatus('07:45', '08:00'), 'present');
  assert.equal(checkInStatus('08:00', '08:00:00'), 'present');
  assert.equal(checkInStatus('08:01', '08:00'), 'late');
  assert.equal(checkInStatus('13:30', '08:00:00'), 'late');
});

test('the time of day is read in Manila (UTC+8), 00:00 to 23:59', () => {
  assert.equal(nowClock(new Date('2026-11-22T00:05:00Z')), '08:05');
  assert.equal(nowClock(new Date('2026-11-22T15:59:00Z')), '23:59');
  assert.equal(nowClock(new Date('2026-11-22T16:00:00Z')), '00:00');
});
