// Vercel serverless function — keeps the Anthropic API key on the server.
// The frontend calls /api/generate-story instead of api.anthropic.com directly.
//
// Gated by payment: the client must first get a signed token from
// /api/verify-payment (proving a 0.05 USDC payment on Base was received)
// and send it here as `paymentToken`. Without a valid, unexpired token,
// no story is generated.

import { verifyToken } from './_payment-token.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
    return;
  }

  const { name, paymentToken } = req.body || {};

  const payment = verifyToken(paymentToken);
  if (!payment) {
    res.status(402).json({ error: 'Payment required or payment proof expired. Please pay and verify the transaction again.' });
    return;
  }

  const safeName = (typeof name === 'string' && name.trim()) ? name.trim() : 'Dad';

  // Same randomized angle/tone pool as before — picked server-side now
  const ANGLES = [
    'the things he gave up silently so his family never had to ask',
    'years of small, unglamorous effort that nobody ever thanked him for',
    'putting his own wants last, again and again, without ever making it a story about himself',
    'the gap between how tired he must have been and how steady he always looked',
    'one ordinary day of work standing in for a thousand others just like it',
    'the comfort he gave that he never let cost him on the outside',
    'a sacrifice disguised as something ordinary — a missed meal, a postponed dream, a worn-out pair of shoes',
    'the weight he carried that the family only half-noticed at the time',
    'his quiet refusal to let his children see how hard things sometimes were',
    'something he gave that can never really be paid back, said plainly'
  ];
  const TONES = [
    'wry and warm, with a small smile hidden in it',
    'hushed and cinematic, like a final voiceover line',
    'plainspoken and unsentimental, letting the detail do the emotional work',
    'slightly nostalgic and golden-lit, like an old photograph come alive',
    'quiet and restrained, saying less than it means',
    'a little playful before turning tender in the last line'
  ];

  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const tone = TONES[Math.floor(Math.random() * TONES.length)];
  const seed = Math.floor(Math.random() * 1000000);

  const prompt = `Write a short Father's Day tribute (50 to 75 words) about a father named ${safeName}.
Do not ask for or rely on any personal memory — invent one small, plausible, vivid scene from scratch.
Center it entirely on a father's quiet sacrifice for his family, built specifically around: ${angle}.
Tone: ${tone}.
Avoid generic Father's Day phrases ("you taught me", "my hero", "thank you for everything", "best dad ever") entirely.
Vary your sentence rhythm — mix short and long sentences.
This is generation #${seed} — make it feel distinct, not formulaic, and different from a typical greeting-card line.
Return ONLY the tribute text itself, no preamble, no quotation marks, no markdown, no title.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: 'Anthropic API error', detail: errText });
      return;
    }

    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || '').join('').trim();

    res.status(200).json({ story: text || 'Could not write the story right now. Please try again.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
