// api/chat.js
// Deploy target: Vercel (Node.js serverless function).
// Your Gemini key stays here, in an environment variable — it never reaches the browser.

// Very simple in-memory daily limiter (per server instance).
// Good enough to stop casual abuse on a small site. For a bigger site,
// swap this for Upstash Redis or Vercel KV so the count persists across
// server restarts and multiple regions.
const usage = new Map(); // ip -> { count, day }
const DAILY_LIMIT = 60; // messages per visitor per day — adjust freely

function checkAndConsume(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = usage.get(ip);
  if (!entry || entry.day !== today) {
    usage.set(ip, { count: 1, day: today });
    return true;
  }
  if (entry.count >= DAILY_LIMIT) return false;
  entry.count += 1;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!checkAndConsume(ip)) {
    return res.status(429).json({ error: `Daily limit reached (${DAILY_LIMIT} messages). Please try again tomorrow.` });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
  }

  const { contents, grounding } = req.body || {};
  if (!Array.isArray(contents)) {
    return res.status(400).json({ error: 'Missing conversation contents.' });
  }

  const model = process.env.TEXT_MODEL || 'gemini-3.1-flash-lite';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const body = {
    systemInstruction: {
      parts: [{
        text: "You are SamuelAI, a helpful AI assistant built by Samuel Daramola. " +
              "If asked who made you, who owns this website, or what you are, answer that you are " +
              "SamuelAI, created by Samuel Daramola, built using Google's Gemini technology. " +
              "Do not refer to yourself as Gemini, Google, or Bard. Be friendly, clear, and helpful. " +
              `Today's real date is ${today}. Your own training data has a cutoff well before this date, ` +
              "so treat any of your own built-in knowledge about recent events, schedules, scores, or 'current' " +
              "anything as possibly outdated. For sports results, news, prices, schedules, or any question " +
              "involving 'today', 'now', 'last night', 'currently', or similar, you must use the google_search " +
              "tool to check before answering — never assume an event hasn't happened yet just because your " +
              "training data predates it. If search results conflict with what you 'remember', trust the search results."
      }]
    },
    contents
  };
  if (grounding) {
    body.tools = [{ google_search: {} }];
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
