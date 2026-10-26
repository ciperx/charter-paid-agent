/** Pay the public endpoint once with a real authorization, and print the settlement. */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const URL_TARGET = process.argv[2];
const wallet = JSON.parse(readFileSync('/opt/data/profiles/idea/cache/scratch/autonomous-income/secrets/taskmarket_wallet.json', 'utf8'));
const account = privateKeyToAccount(wallet.privateKey);
const now = Math.floor(Date.now() / 1000);
const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const message = { from: account.address, to: account.address, value: 10000n, validAfter: BigInt(now - 60), validBefore: BigInt(now + 300), nonce };
const signature = await account.signTypedData({
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ]},
  primaryType: 'TransferWithAuthorization',
  message,
});
const envelope = {
  x402Version: 2, scheme: 'exact', network: 'eip155:8453',
  payload: { signature, authorization: { ...message, value: '10000', validAfter: String(message.validAfter), validBefore: String(message.validBefore) } },
  accepted: { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: account.address },
};
const header = Buffer.from(JSON.stringify(envelope)).toString('base64');
const body = JSON.stringify({ capability: 'charter.parse', input: { data_hex: '0x' + '00'.repeat(160) } });
const unpaid = await fetch(URL_TARGET, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
console.log('public unpaid', unpaid.status);
const paid = await fetch(URL_TARGET, { method: 'POST', headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header }, body });
const text = await paid.text();
console.log('public paid', paid.status, text.slice(0, 260));
