/**
 * Charter attestation agent: a paid x402 skill.
 *
 * One capability, deliberately deterministic: decode the charter payload of an EAS attestation.
 * The caller supplies the raw attestation data, so the answer never depends on a network read and
 * a buyer can check it against the chain themselves.
 *
 * An unpaid call answers 402 with the x402 terms. A paid call is verified by the injected
 * verifyPayment function before anything is decoded.
 */
import { createServer } from 'node:http';
import { decodeCharterData } from './lib/charter.js';

export const PRICE_ATOMIC = '10000'; // 0.01 USDC, six decimals
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const RESOURCE_URL = process.env.RESOURCE_URL || 'https://agent.example.com';
export const PAY_TO = process.env.PAY_TO || '0x226ea74D26E2aA98973Dc35ffE7E66fa2e3B2588';

export const CAPABILITIES = {
  'charter.parse': {
    description: 'Decode the charter payload of a Base EAS attestation from its raw data.',
    price_atomic: PRICE_ATOMIC,
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function terms(resource) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: PRICE_ATOMIC,
        resource,
        description: 'Charter attestation decode',
        mimeType: 'application/json',
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };
}

export function createAgent({ verifyPayment } = {}) {
  return async function handler({ method, path, headers, body }) {
    if (path === '/health' && method === 'GET') {
      return { status: 200, json: { ok: true, capabilities: Object.keys(CAPABILITIES) } };
    }
    if (path !== '/v1/charter') return { status: 404, json: { error: 'not found' } };

    const payment = headers['x-payment'] || headers['X-PAYMENT'];
    if (!payment) {
      return { status: 402, headers: { 'PAYMENT-REQUIRED': JSON.stringify(terms(`${RESOURCE_URL}${path}`)) }, json: terms(`${RESOURCE_URL}${path}`) };
    }
    if (typeof verifyPayment !== 'function') {
      return { status: 503, json: { error: 'payment verification is not configured' } };
    }
    const verdict = await verifyPayment(payment, { price_atomic: PRICE_ATOMIC });
    if (!verdict || !verdict.ok) {
      return { status: 402, json: { error: 'payment not accepted', reason: verdict?.reason ?? 'unknown' } };
    }

    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return { status: 400, json: { error: 'body is not JSON' } };
    }
    if (parsed.capability !== 'charter.parse') {
      return { status: 400, json: { error: 'unknown capability', known: Object.keys(CAPABILITIES) } };
    }
    const dataHex = parsed.input?.data_hex;
    if (typeof dataHex !== 'string' || !/^0x[0-9a-f]*$/i.test(dataHex)) {
      return { status: 400, json: { error: 'input.data_hex must be 0x hex' } };
    }
    try {
      const decoded = decodeCharterData(dataHex);
      return { status: 200, json: decoded };
    } catch (error) {
      return { status: 422, json: { error: 'payload could not be decoded', reason: String(error.message || error) } };
    }
  };
}

export function listen({ port = Number(process.env.PORT) || 8095, verifyPayment } = {}) {
  const handler = createAgent({ verifyPayment });
  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : '';
    const answer = await handler({ method: req.method, path: new URL(req.url, 'http://localhost').pathname, headers: req.headers, body });
    res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers || {}) });
    res.end(JSON.stringify(answer.json));
  });
  server.listen(port);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = listen();
  server.on('listening', () => console.error(`charter agent listening on ${server.address().port}`));
}
