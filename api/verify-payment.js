// Vercel serverless function — verifies a 0.05 USDC payment on Base mainnet
// before letting the client unlock /api/generate-story.
//
// How it works:
// 1. Client sends the tx hash the user pasted in after paying.
// 2. We fetch the transaction receipt from a Base RPC node and check:
//      - it succeeded (status === 1)
//      - it called the official Base USDC contract
//      - it emitted an ERC-20 Transfer event to OUR wallet
//      - the transferred amount is >= the required amount (0.05 USDC)
// 3. If all checks pass, we mark the tx hash as "used" (single-use) and
//    return a short-lived signed token the client must send along with
//    its /api/generate-story request.
//
// IMPORTANT LIMITATION (read before relying on this in production):
// The "used tx hash" set below is stored in memory. Vercel serverless
// functions are stateless and can spin up fresh instances at any time
// (cold starts, scaling, redeploys), so this in-memory set does NOT
// guarantee a tx hash can only ever be redeemed once globally — it only
// prevents reuse within the same warm instance / short time window.
// For real single-use enforcement across all instances, swap the
// in-memory Set below for a persistent store such as Vercel KV or
// Upstash Redis (both have free tiers) — see the USED_TX_STORE section.

import { signToken } from './_payment-token.js';

// ---- Config ----------------------------------------------------------
const BASE_CHAIN_ID = 8453; // Base mainnet
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // native USDC on Base (Circle-verified)
const RECEIVER_WALLET = '0xBc7a2123F1148B67aA7fdD1D2faEA1a88CE8955f'; // your wallet
const REQUIRED_USDC = 0.05; // minimum amount required
const USDC_DECIMALS = 6;
const REQUIRED_UNITS = BigInt(Math.round(REQUIRED_USDC * 10 ** USDC_DECIMALS)); // 50000

// Public Base RPC (rate-limited, fine for low volume). For higher volume,
// swap in a provider like Alchemy/Coinbase Developer Platform/QuickNode
// and set BASE_RPC_URL as an env var instead.
const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
// keccak256("Transfer(address,address,uint256)") — verified against multiple
// independent sources (ethers.js docs, MetaMask docs, otterscan/topic0 DB).
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Secret used to sign the short-lived unlock token returned to the client.
// (Shared with generate-story.js via _payment-token.js — set PAYMENT_TOKEN_SECRET
// as an env var in Vercel so both functions agree on the same secret.)
const TOKEN_TTL_MS = 10 * 60 * 1000; // unlock token valid for 10 minutes

// ---- "Used tx hash" store ---------------------------------------------
// In-memory only — see limitation note above. Swap for Vercel KV / Upstash
// Redis for real cross-instance single-use enforcement:
//
//   import { kv } from '@vercel/kv';
//   const already = await kv.get(`usedtx:${txHash}`);
//   if (already) { ...reject... }
//   await kv.set(`usedtx:${txHash}`, '1', { ex: 60 * 60 * 24 * 30 });
//
const usedTxHashes = global.__memoryReelUsedTx || (global.__memoryReelUsedTx = new Set());

function isValidTxHash(hash) {
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash);
}

function topicToAddress(topic) {
  // topic is a 32-byte hex value; an address is the last 20 bytes
  return ('0x' + topic.slice(-40)).toLowerCase();
}

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`RPC HTTP error ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { txHash } = req.body || {};

  if (!isValidTxHash(txHash)) {
    res.status(400).json({ ok: false, error: 'That doesn\'t look like a valid transaction hash (expected 0x + 64 hex chars).' });
    return;
  }

  const normalizedHash = txHash.toLowerCase();

  if (usedTxHashes.has(normalizedHash)) {
    res.status(409).json({ ok: false, error: 'This transaction has already been used to unlock a story.' });
    return;
  }

  try {
    // 1) Confirm we're talking to Base mainnet (sanity check on RPC config)
    const chainIdHex = await rpcCall('eth_chainId', []);
    if (parseInt(chainIdHex, 16) !== BASE_CHAIN_ID) {
      res.status(500).json({ ok: false, error: 'Server RPC is not configured for Base mainnet.' });
      return;
    }

    // 2) Fetch the transaction receipt
    const receipt = await rpcCall('eth_getTransactionReceipt', [normalizedHash]);
    if (!receipt) {
      res.status(404).json({ ok: false, error: 'Transaction not found yet. If you just sent it, wait a few seconds for it to confirm and try again.' });
      return;
    }

    if (receipt.status !== '0x1') {
      res.status(400).json({ ok: false, error: 'That transaction failed on-chain, so no payment was received.' });
      return;
    }

    // 3) Look through the logs for a USDC Transfer event to our wallet
    const logs = receipt.logs || [];
    let matched = false;
    let matchedAmountUnits = 0n;

    for (const log of logs) {
      if (!log.address || log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      if (!log.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
      if (log.topics.length < 3) continue;

      const toAddress = topicToAddress(log.topics[2]);
      if (toAddress !== RECEIVER_WALLET.toLowerCase()) continue;

      const amountUnits = BigInt(log.data);
      if (amountUnits >= REQUIRED_UNITS) {
        matched = true;
        matchedAmountUnits = amountUnits;
        break;
      }
    }

    if (!matched) {
      res.status(400).json({
        ok: false,
        error: `No USDC transfer of at least ${REQUIRED_USDC} USDC to the payment wallet was found in that transaction. Double-check the tx hash, network (Base), token (USDC), recipient, and amount.`
      });
      return;
    }

    // 4) Mark used and issue a short-lived unlock token
    usedTxHashes.add(normalizedHash);

    const amountUsdc = Number(matchedAmountUnits) / 10 ** USDC_DECIMALS;
    const payload = {
      txHash: normalizedHash,
      amount: amountUsdc,
      exp: Date.now() + TOKEN_TTL_MS
    };
    const token = signToken(payload);

    res.status(200).json({ ok: true, token, amount: amountUsdc });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not verify the transaction right now. Please try again in a moment.', detail: String(err) });
  }
}
