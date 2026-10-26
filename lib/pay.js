/**
 * A small self hosted x402 paywall for USDC on Base.
 *
 * The public facilitator only settles testnets, so the agent settles on its own: it recovers the
 * payer from the EIP-712 TransferWithAuthorization signature, refuses an authorization whose nonce is
 * already used, and then submits the transfer itself with the relayer key. A payment is only
 * accepted after the receipt of that transaction is successful.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const USDC_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export function createPaywall({ relayerKey, rpcUrl, asset, payTo, priceAtomic, domainName = 'USD Coin', domainVersion = '2', chainId = 8453 }) {
  const account = privateKeyToAccount(relayerKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });
  const usedNonces = new Set();

  async function verifyPayment(headerValue, ctx = {}) {
    const price = BigInt(ctx.price_atomic ?? priceAtomic ?? '0');
    let envelope;
    try {
      envelope = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
    } catch {
      return { ok: false, reason: 'the payment header is not base64 JSON' };
    }
    const payload = envelope?.payload ?? {};
    const auth = payload.authorization ?? envelope?.authorization;
    const signature = payload.signature ?? envelope?.signature;
    if (!auth || !signature) return { ok: false, reason: 'the payment is missing the authorization or signature' };

    if (String(auth.to).toLowerCase() !== payTo.toLowerCase()) return { ok: false, reason: 'paid to the wrong address' };
    let value;
    try {
      value = BigInt(auth.value);
    } catch {
      return { ok: false, reason: 'value is not an integer' };
    }
    if (value < price) return { ok: false, reason: `paid ${value}, needs ${price}` };

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(auth.validAfter) > now) return { ok: false, reason: 'authorization is not valid yet' };
    if (BigInt(auth.validBefore) <= now) return { ok: false, reason: 'authorization has expired' };
    if (usedNonces.has(auth.nonce.toLowerCase())) return { ok: false, reason: 'nonce already used in this process' };

    let signer;
    try {
      const { recoverTypedDataAddress } = await import('viem');
      signer = await recoverTypedDataAddress({
        domain: { name: domainName, version: domainVersion, chainId, verifyingContract: asset },
        types: TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: auth.from,
          to: auth.to,
          value,
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce,
        },
        signature,
      });
    } catch (error) {
      return { ok: false, reason: `signature could not be recovered: ${String(error.message || error)}` };
    }
    if (signer.toLowerCase() !== String(auth.from).toLowerCase()) {
      return { ok: false, reason: 'the signature does not belong to the payer' };
    }

    try {
      const alreadyUsed = await publicClient.readContract({
        address: asset,
        abi: USDC_ABI,
        functionName: 'authorizationState',
        args: [auth.from, auth.nonce],
      });
      if (alreadyUsed) return { ok: false, reason: 'nonce already used on chain' };
    } catch (error) {
      return { ok: false, reason: `could not read the authorization state: ${String(error.message || error)}` };
    }

    try {
      const hash = await walletClient.writeContract({
        address: asset,
        abi: USDC_ABI,
        functionName: 'transferWithAuthorization',
        args: [auth.from, auth.to, value, BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, signature],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== 'success') return { ok: false, reason: 'the settlement transaction reverted' };
      usedNonces.add(auth.nonce.toLowerCase());
      return { ok: true, transaction: hash, value: value.toString() };
    } catch (error) {
      return { ok: false, reason: `settlement failed: ${String(error.message || error)}` };
    }
  }

  return { verifyPayment, address: account.address };
}

export default createPaywall;
