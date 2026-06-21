// Shared helper: a small signed, expiring token that proves a payment was
// already verified by /api/verify-payment, without needing a database.
//
// It's just base64url(JSON payload) + "." + HMAC-SHA256 signature, using a
// secret only the server knows. Anyone can read the payload, but nobody can
// forge or alter it without the secret — which is what we actually need
// here (we're not hiding data, just proving "the server checked this").
//
// Set PAYMENT_TOKEN_SECRET as an env var in Vercel (any long random string).
// If it's not set, a fallback dev secret is used — fine for local testing,
// NOT fine for production (anyone could mint their own valid tokens).

import crypto from 'crypto';

const TOKEN_SECRET = process.env.PAYMENT_TOKEN_SECRET || 'dev-only-insecure-secret-change-me';

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');

  // Constant-time comparison to avoid timing attacks
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return null; // expired
  }

  return payload;
}
