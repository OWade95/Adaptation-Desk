// Secrets are read only by this server function, never by browser code.
// These limits are per warm function instance, not a global spending cap.
const windows = new Map();
let active = 0;
const HOUR = 60 * 60 * 1000;
const MAX_PROMPT = 100000;

function consume(key, limit, now) {
  let entry = windows.get(key);
  if (!entry || entry.until <= now) {
    entry = { count: 0, until: now + HOUR };
    windows.set(key, entry);
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function upstreamError(status, data) {
  const detail = String(data?.error?.message || '').toLowerCase();
  if (detail.includes('credit') || detail.includes('billing')) {
    return 'AI processing credits are unavailable. Please contact the site owner.';
  }
  if (status === 401 || status === 403) {
    return 'The AI service could not authenticate. Please contact the site owner.';
  }
  if (status === 404) return 'The AI service is unavailable for this account. Please contact the site owner.';
  if (status === 429) return 'The AI service is temporarily rate-limited. Please wait a minute and try again.';
  return 'AI could not complete this request. Please try again shortly.';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({ configured: Boolean(process.env.ANTHROPIC_API_KEY) });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Reject cross-site browser calls; this is not user authentication.
  const origin = req.headers.origin;
  const host = req.headers.host;
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin && new URL(origin).host === host); } catch {}
  if (!sameOrigin) return res.status(403).json({ error: 'Open Adaptation Desk to make this request.' });
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return res.status(415).json({ error: 'Send a JSON request.' });
  }
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON request.' }); }
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return res.status(400).json({ error: 'The request is empty.' });
  if (prompt.length > MAX_PROMPT) return res.status(413).json({ error: 'The article is too long. Use a shorter extract.' });
  // One resized PDF page per request keeps the payload below Vercel's 4.5 MB limit.
  let image = null;
  if (body.image !== undefined) {
    const value = body.image;
    if (!value || value.media_type !== 'image/jpeg' || typeof value.data !== 'string' ||
        value.data.length > 3500000 || value.data.length < 16 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || value.data.length % 4 !== 0) {
      return res.status(400).json({ error: 'The PDF page image is invalid or too large. Try fewer or simpler pages.' });
    }
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return res.status(400).json({ error: 'The PDF page could not be read as an image.' });
    }
    image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: value.data } };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI processing is not configured. Please contact the site owner.' });

  const now = Date.now();
  for (const [key, entry] of windows) if (entry.until <= now) windows.delete(key);
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (active >= 12 || !consume('all', 300, now) || !consume('ip:' + ip, 80, now)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'The prototype has reached its request limit. Please try again later.' });
  }

  active++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: image ? [image, { type: 'text', text: prompt }] : prompt }]
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: upstreamError(response.status, data) });
    if (data?.stop_reason === 'max_tokens') return res.status(502).json({ error: 'AI reached the response limit. Try a shorter article or request.' });
    const text = Array.isArray(data?.content) ? data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
    if (!text.trim()) return res.status(502).json({ error: 'AI returned no text. Please try again.' });
    return res.status(200).json({ text, ...(image ? { visualRead: true } : {}) });
  } catch (error) {
    return res.status(error.name === 'AbortError' ? 504 : 502).json({ error: error.name === 'AbortError' ? 'AI took too long to respond. Please try again.' : 'Unable to reach the AI service. Please try again shortly.' });
  } finally {
    clearTimeout(timeout);
    active--;
  }
}
