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
import { decodeCharterData, verifyCharter } from './lib/charter.js';
import { createPaywall } from './lib/pay.js';

export const PRICE_ATOMIC = '10000'; // 0.01 USDC, six decimals
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const RESOURCE_URL = process.env.RESOURCE_URL || 'https://agent.example.com';
export const PAY_TO = process.env.PAY_TO || '0x226ea74D26E2aA98973Dc35ffE7E66fa2e3B2588';

export const CAPABILITIES = {
  'charter.parse': {
    description: 'Decode the charter payload of a Base EAS attestation from its raw data.',
    price_atomic: PRICE_ATOMIC,
  },
  'charter.verify': {
    description: 'Fetch an attestation by uid from Base, decode its charter payload and check every text against its sha256 digest, including the IPFS fetch.',
    price_atomic: PRICE_ATOMIC,
  },
};

const UID_RE = /^0x[0-9a-fA-F]{64}$/;

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

    // 1. Read the request. Nothing here costs money.
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return { status: 400, json: { error: 'body is not JSON' } };
    }

    const capability = parsed.capability;
    if (!capability || !CAPABILITIES[capability]) {
      return { status: 400, json: { error: 'unknown capability', known: Object.keys(CAPABILITIES) } };
    }

    // 2. Validate the input before any payment is taken, so a refusal never costs the caller.
    const input = parsed.input ?? {};
    let dataHex = null;
    let uid = null;
    let network = 8453;
    if (capability === 'charter.parse') {
      dataHex = input.data_hex;
      if (typeof dataHex !== 'string' || !/^0x[0-9a-f]*$/i.test(dataHex)) {
        return { status: 400, json: { error: 'input.data_hex must be 0x hex' } };
      }
    } else {
      uid = input.uid;
      network = Number(input.network ?? 8453);
      if (typeof uid !== 'string' || !UID_RE.test(uid)) {
        return { status: 400, json: { error: 'input.uid must be 0x followed by 64 hex characters' } };
      }
      if (![8453, 84532].includes(network)) {
        return { status: 400, json: { error: 'input.network must be 8453 or 84532' } };
      }
    }

    // 3. Ask for payment only once the call is known to be answerable.
    const payment = headers['x-payment'] || headers['payment-signature'] || headers['X-PAYMENT'] || headers['PAYMENT-SIGNATURE'];
    if (!payment) {
      const body402 = terms(`${RESOURCE_URL}${path}`);
      return { status: 402, headers: { 'PAYMENT-REQUIRED': JSON.stringify(body402) }, json: body402 };
    }
    if (typeof verifyPayment !== 'function') {
      return { status: 503, json: { error: 'payment verification is not configured' } };
    }
    const verdict = await verifyPayment(payment, { price_atomic: CAPABILITIES[capability].price_atomic });
    if (!verdict || !verdict.ok) {
      return { status: 402, json: { error: 'payment not accepted', reason: verdict?.reason ?? 'unknown' } };
    }

    const settled = {
      headers: {
        'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction: verdict.transaction ?? null, network: 'eip155:8453' })).toString('base64'),
      },
    };
    const paid = { transaction: verdict.transaction ?? null };

    // 4. Do the work.
    if (capability === 'charter.parse') {
      try {
        return { ...settled, status: 200, json: { ...decodeCharterData(dataHex), paid } };
      } catch (error) {
        return { ...settled, status: 422, json: { error: 'payload could not be decoded', reason: String(error.message || error), paid } };
      }
    }

    const result = await verifyCharter({
      uid,
      network,
      rpc: process.env.BASE_RPC || undefined,
      ipfs: input.ipfs_gateway || undefined,
    });
    const status = result.attestation?.attester ? 200 : 422;
    return { ...settled, status, json: { ...result, paid } };
  };
}

export function settleFromEnv() {
  const key = process.env.RELAYER_KEY;
  if (!key) return undefined;
  const { verifyPayment } = createPaywall({
    relayerKey: key,
    rpcUrl: process.env.BASE_RPC || 'https://base.gateway.tenderly.co',
    asset: USDC_BASE,
    payTo: PAY_TO,
    priceAtomic: PRICE_ATOMIC,
  });
  return verifyPayment;
}

export function listen({ port = Number(process.env.PORT) || 8095, verifyPayment = settleFromEnv() } = {}) {
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
