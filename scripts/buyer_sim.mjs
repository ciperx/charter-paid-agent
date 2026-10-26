/**
 * Pretend to be a buyer who only knows the listing id.
 *
 * Reads the offer from LAX, takes the endpoint and the price from the listing itself (not from any
 * local file), calls it unpaid, pays with a real authorization, and prints what came back.
 */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const LISTING = process.argv[2] || 'lax-ext-1150650de199';
const listing = await (await fetch(`https://lax.kognai.ai/registry/offers/${LISTING}`)).json();
const offer = listing.offer ?? listing;
const endpoint = offer.endpoint;
const cap = offer.capabilities[0];
console.log('from the listing:', offer.name, '|', endpoint, '| price', cap.pricing.amount, cap.pricing.currency);

const unpaid = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const challenge = await unpaid.json();
console.log('unpaid:', unpaid.status, '| terms:', challenge.accepts?.[0]?.maxAmountRequired, challenge.accepts?.[0]?.network);

const wallet = JSON.parse(readFileSync('/opt/data/profiles/idea/cache/scratch/autonomous-income/secrets/taskmarket_wallet.json', 'utf8'));
const account = privateKeyToAccount(wallet.privateKey);
const accept = challenge.accepts[0];
const now = Math.floor(Date.now() / 1000);
const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const message = { from: account.address, to: accept.payTo, value: BigInt(accept.maxAmountRequired), validAfter: BigInt(now - 60), validBefore: BigInt(now + 300), nonce };
const signature = await account.signTypedData({
  domain: { name: accept.asset === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' ? 'USD Coin' : 'USD Coin', version: '2', chainId: 8453, verifyingContract: accept.asset },
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
  accepted: { scheme: 'exact', network: 'eip155:8453', amount: accept.maxAmountRequired, asset: accept.asset, payTo: accept.payTo },
};
const header = Buffer.from(JSON.stringify(envelope)).toString('base64');
const body = JSON.stringify({ capability: 'charter.verify', input: { uid: '0xb903bf80cd48a21769863b7922822a4bb4a0a809f91ab4ad4bd60ca76b989ab7' } });
const paid = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header }, body });
console.log('paid:', paid.status, (await paid.text()).slice(0, 300));
