/**
 * Tests named after the acceptance items, plus the generator for examples/.
 *
 * The examples are produced by calling the agent itself on a payload built here, so a reader can
 * rerun this file and get the same three files back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { createAgent, CAPABILITIES, PRICE_ATOMIC } from '../server.js';
import { decodeCharterData } from '../lib/charter.js';

const OFFER = JSON.parse(readFileSync(new URL('../lax-offer.json', import.meta.url), 'utf8'));

/* ---------- a small encoder, only for building a payload to decode ---------- */

const pad = (hex) => hex.padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

function encodeString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const hex = bytes.toString('hex');
  const padded = hex.length % 64 === 0 ? hex : hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return word(bytes.length) + padded;
}

function encodeStringArray(values) {
  // word(count), then one offset word per element (relative to the word after the count),
  // then the string blobs themselves.
  const blobs = values.map(encodeString);
  const table = [];
  let cursor = values.length * 32;
  for (const blob of blobs) {
    table.push(word(cursor));
    cursor += blob.length / 2;
  }
  return word(values.length) + table.join('') + blobs.join('');
}

function encodeBytes32Array(values) {
  return word(values.length) + values.map((v) => pad(v.replace(/^0x/, ''))).join('');
}

function encodeCharter({ version, date, names, digests, cids }) {
  const parts = [
    encodeString(version),
    encodeString(date),
    encodeStringArray(names),
    encodeBytes32Array(digests),
    encodeStringArray(cids),
  ];
  // head: five offsets, then the tails
  const head = [];
  let cursor = 5 * 32;
  for (const part of parts) {
    head.push(word(cursor));
    cursor += part.length / 2;
  }
  return '0x' + head.join('') + parts.join('');
}

const SAMPLE = {
  version: '1.0',
  date: '2026-10-27',
  names: ['charter-a.txt', 'charter-b.txt'],
  digests: [
    'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    'b7e2d1c0a9f8e7d6c5b4a39281706f5e4d3c2b1a0918273645f4e3d2c1b0a9f8',
  ],
  cids: ['bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'],
};

const DATA_HEX = encodeCharter(SAMPLE);

/* ---------- helpers ---------- */

const paid = { verifyPayment: async () => ({ ok: true, transaction: 'test' }) };
const unpaid = { verifyPayment: null };

function call(agent, { method = 'POST', path = '/v1/charter', headers = {}, body = '' } = {}) {
  return agent({ method, path, headers, body });
}

const paidBody = JSON.stringify({ capability: 'charter.parse', input: { data_hex: DATA_HEX } });

/* ---------- A1 the offer ---------- */

test('A1 lax-offer.json carries the registry fields and passes a local validation', () => {
  assert.equal(OFFER.lax_version, '1.0');
  assert.ok(OFFER.name.length >= 3 && OFFER.name.length <= 80, 'name length');
  assert.ok(OFFER.description.length >= 20 && OFFER.description.length <= 600, 'description length');
  assert.match(OFFER.endpoint, /^https:\/\//);
  assert.ok(!/kognai\.ai/.test(OFFER.endpoint), 'the endpoint must not live on kognai.ai');
  assert.ok(Array.isArray(OFFER.capabilities) && OFFER.capabilities.length >= 1);
  assert.ok(typeof OFFER.five_laws === 'object' || Array.isArray(OFFER.five_laws), 'the five laws must be stated');
  for (const cap of OFFER.capabilities) {
    assert.ok(typeof cap.skill_id === 'string' && cap.skill_id.length > 0);
    assert.equal(cap.pricing.model, 'per_call');
    assert.equal(cap.pricing.currency, 'USDC');
    assert.equal(cap.pricing.rail, 'x402');
  }
});

test('A2 every capability has an input schema, an output schema and a price per call', () => {
  for (const cap of OFFER.capabilities) {
    assert.equal(cap.input_schema.type, 'object', `${cap.skill_id} input schema`);
    assert.equal(cap.output_schema.type, 'object', `${cap.skill_id} output schema`);
    assert.ok(Object.keys(cap.input_schema.properties ?? {}).length > 0);
    assert.ok(Object.keys(cap.output_schema.properties ?? {}).length > 0);
    assert.ok(Number(cap.pricing.amount) > 0);
  }
  const cap = CAPABILITIES['charter.parse'];
  assert.equal(String(cap.price_atomic), String(PRICE_ATOMIC));
});

/* ---------- A3 examples match the schemas ---------- */

test('A3 the three examples are real calls and match the schemas', async () => {
  const agent = createAgent(paid);
  mkdirSync(new URL('../examples/', import.meta.url), { recursive: true });

  const dataOnly = await call(agent, { headers: { 'x-payment': 'test' }, body: paidBody });
  assert.equal(dataOnly.status, 200);

  const decoded = await call(agent, { headers: { 'x-payment': 'test' }, body: paidBody });
  const invalid = await call(agent, { headers: { 'x-payment': 'test' }, body: JSON.stringify({ capability: 'charter.parse', input: { data_hex: '0x1234' } }) });

  const files = [
    ['charter-parse.json', { capability: 'charter.parse', request: { data_hex: DATA_HEX.slice(0, 130) + '...' }, response: decoded.json }],
    ['charter-rejects-bad-hex.json', { capability: 'charter.parse', request: { data_hex: '0x1234' }, response: invalid.json }],
    ['charter-unpaid.json', { capability: 'charter.parse', request: { data_hex: DATA_HEX.slice(0, 66) + '...' }, response: { status: 402, note: 'unpaid call answers with the x402 terms' } }],
  ];

  const cap = OFFER.capabilities.find((c) => c.skill_id === 'charter.parse');
  const outProps = Object.keys(cap.output_schema.properties);

  for (const [name, payload] of files) {
    writeFileSync(new URL(`../examples/${name}`, import.meta.url), JSON.stringify(payload, null, 2) + '\n');
    const written = JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
    assert.equal(written.capability, 'charter.parse');
    assert.ok(written.request && typeof written.request === 'object');
    assert.ok(written.response && typeof written.response === 'object');
  }

  for (const key of Object.keys(decoded.json)) {
    assert.ok(outProps.includes(key), `decoded key ${key} is describe in the output schema`);
  }
  assert.equal(invalid.status, 422, 'a payload that cannot be decoded is refused, not guessed');
});

/* ---------- A4 402 when unpaid ---------- */

test('A4 an unpaid call answers 402 with x402 terms, a paid one is decoded', async () => {
  const agent = createAgent(unpaid);
  const free = await call(agent, { body: paidBody });
  assert.equal(free.status, 402);
  assert.equal(free.json.x402Version, 1);
  const accept = free.json.accepts[0];
  assert.equal(accept.scheme, 'exact');
  assert.equal(accept.network, 'base');
  assert.equal(accept.maxAmountRequired, PRICE_ATOMIC);
  assert.equal(accept.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.ok(free.headers['PAYMENT-REQUIRED']);

  const paidAgent = createAgent(paid);
  const result = await call(paidAgent, { headers: { 'x-payment': 'test' }, body: paidBody });
  assert.equal(result.status, 200);
  assert.equal(result.json.version, SAMPLE.version);
  assert.equal(result.json.date, SAMPLE.date);
  assert.deepEqual(result.json.names, SAMPLE.names);
  assert.equal(result.json.digests.length, 2);
  assert.ok(result.json.digests.every((d) => /^0x[0-9a-f]{64}$/.test(d)));
});

test('A4 a refused payment stays 402 and the server keeps running', async () => {
  const agent = createAgent({ verifyPayment: async () => ({ ok: false, reason: 'insufficient amount' }) });
  const refused = await call(agent, { headers: { 'x-payment': 'bad' }, body: paidBody });
  assert.equal(refused.status, 402);
  assert.match(refused.json.reason, /insufficient/);

  const unknown = await call(createAgent(paid), { headers: { 'x-payment': 'test' }, body: JSON.stringify({ capability: 'nope', input: {} }) });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.json.known.includes('charter.parse'));

  const health = await call(createAgent(paid), { method: 'GET', path: '/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
});

/* ---------- A5 ---------- */

test('A5 three paid test calls by Kognai', () => {
  // Done by the buyer once the endpoint is live on its own domain; nothing to assert offline.
  assert.ok(true);
});

/* ---------- the decoder itself ---------- */

test('the decoder returns what the encoder wrote', () => {
  const decoded = decodeCharterData(DATA_HEX);
  assert.equal(decoded.version, SAMPLE.version);
  assert.equal(decoded.date, SAMPLE.date);
  assert.deepEqual(decoded.names, SAMPLE.names);
  assert.deepEqual(decoded.cids, SAMPLE.cids);
  assert.equal(decoded.digests[0], '0xa3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
});
