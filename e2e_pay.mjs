import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { listen, PRICE_ATOMIC, USDC_BASE, PAY_TO } from './server.js';

const wallet = JSON.parse(readFileSync('/opt/data/profiles/idea/cache/scratch/autonomous-income/secrets/taskmarket_wallet.json', 'utf8'));
const account = privateKeyToAccount(wallet.privateKey);
process.env.RELAYER_KEY = wallet.privateKey;

const now = Math.floor(Date.now() / 1000);
const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const message = {
  from: account.address,
  to: PAY_TO,
  value: BigInt(PRICE_ATOMIC),
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + 300),
  nonce,
};
const signature = await account.signTypedData({
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE },
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ]},
  primaryType: 'TransferWithAuthorization',
  message,
});

const envelope = {
  x402Version: 2, scheme: 'exact', network: 'eip155:8453',
  payload: { signature, authorization: { ...message, value: message.value.toString(), validAfter: String(message.validAfter), validBefore: String(message.validBefore) } },
  accepted: { scheme: 'exact', network: 'eip155:8453', amount: PRICE_ATOMIC, asset: USDC_BASE, payTo: PAY_TO },
};
const header = Buffer.from(JSON.stringify(envelope)).toString('base64');

const server = listen({ port: 8099 });
await new Promise((r) => server.on('listening', r));

const unpaid = await fetch('http://127.0.0.1:8099/v1/charter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log('unpaid status', unpaid.status);

const body = JSON.stringify({ capability: 'charter.parse', input: { data_hex: '0x' + '00'.repeat(160) } });
const paid = await fetch('http://127.0.0.1:8099/v1/charter', { method: 'POST', headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header }, body });
const text = await paid.text();
console.log('paid status', paid.status, text.slice(0, 300));
if (paid.headers.get('x-payment-response')) console.log('settlement header', paid.headers.get('x-payment-response').slice(0, 90));
server.close();
