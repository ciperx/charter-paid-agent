/** Checks for the charter.verify capability, both the guards and the shape of a real answer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgent, CAPABILITIES } from '../server.js';

const OFFER = JSON.parse(readFileSync(new URL('../lax-offer.json', import.meta.url), 'utf8'));
const paid = { verifyPayment: async () => ({ ok: true, transaction: 'test' }) };
const post = (agent, body) => agent({ method: 'POST', path: '/v1/charter', headers: { 'x-payment': 't' }, body: JSON.stringify(body) });

test('the offer lists both capabilities with schemas and a price', () => {
  const ids = OFFER.capabilities.map((c) => c.skill_id).sort();
  assert.deepEqual(ids, ['charter.parse', 'charter.verify']);
  for (const cap of OFFER.capabilities) {
    assert.equal(cap.input_schema.type, 'object');
    assert.equal(cap.output_schema.type, 'object');
    assert.ok(Number(cap.pricing.amount) > 0);
  }
  assert.ok(Object.keys(CAPABILITIES).includes('charter.verify'));
});

test('verify refuses a uid that is not 0x plus 64 hex', async () => {
  const agent = createAgent(paid);
  for (const uid of ['', '0x1234', 'b903bf80', 42]) {
    const r = await post(agent, { capability: 'charter.verify', input: { uid } });
    assert.equal(r.status, 400, `${uid} should be refused`);
    assert.match(r.json.error, /uid/);
  }
});

test('verify refuses an unsupported network', async () => {
  const agent = createAgent(paid);
  const r = await post(agent, { capability: 'charter.verify', input: { uid: '0x' + '11'.repeat(32), network: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /network/);
});

test('verify answers with the attestation fields for a real uid, or says why not', async () => {
  // Offline this cannot reach Base, so the call either answers with the fields or with a reason;
  // what must never happen is a throw or a made up attester.
  const agent = createAgent(paid);
  const r = await post(agent, { capability: 'charter.verify', input: { uid: '0xb903bf80cd48a21769863b7922822a4bb4a0a809f91ab4ad4bd60ca76b989ab7' } });
  assert.ok([200, 422].includes(r.status), `status ${r.status}`);
  assert.equal(r.json.attestation.uid, '0xb903bf80cd48a21769863b7922822a4bb4a0a809f91ab4ad4bd60ca76b989ab7');
  assert.ok(Array.isArray(r.json.texts));
  if (r.json.attestation.attester) {
    assert.match(r.json.attestation.attester, /^0x[0-9a-f]{40}$/);
    assert.ok(Number(r.json.attestation.time) > 1_600_000_000);
  } else {
    assert.ok(typeof r.json.reason === 'string' && r.json.reason.length > 0, 'a failure carries a reason');
  }
});
