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

  const { contents } = req.body || {};
  if (!Array.isArray(contents)) {
    return res.status(400).json({ error: 'Missing conversation contents.' });
  }

  const model = process.env.TEXT_MODEL || 'gemini-3.5-flash-lite';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // Pull the latest user message text, used both to decide whether to
  // search and as the actual search query.
  const lastUserMsg = [...contents].reverse().find(c => c.role === 'user');
  const lastUserText = lastUserMsg?.parts?.find(p => p.text)?.text || '';

  // ---------------------------------------------------------------------
  // LIVE WEB SEARCH via Tavily (free, no billing required — unlike Gemini's
  // own Google Search grounding, which needs a billing-enabled account even
  // for its free monthly allowance). We only spend a search credit when the
  // question looks like it actually needs current information, to make the
  // free 1,000/month allowance last.
  // ---------------------------------------------------------------------
  const TIME_SENSITIVE_PATTERN =
    /\b(today|tonight|tomorrow|yesterday|last night|this week|this month|this year|currently|right now|latest|recent|breaking|news|score|scores|won|winner|result|results|standings|schedule|price|prices|stock|weather|election|update|updates|who is (the )?(current|president|prime minister|ceo)|what('s| is) happening|2026)\b/i;

  let searchContext = '';
  let searchAttempted = false;
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (tavilyKey && lastUserText && TIME_SENSITIVE_PATTERN.test(lastUserText)) {
    searchAttempted = true;
    try {
      const tavilyRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: lastUserText,
          search_depth: 'basic',
          max_results: 5,
          include_answer: false
        })
      });
      if (tavilyRes.ok) {
        const tavilyData = await tavilyRes.json();
        const results = tavilyData.results || [];
        if (results.length) {
          searchContext = results
            .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`)
            .join('\n\n');
        }
      }
      // If Tavily fails or returns nothing, we silently fall through to a
      // normal (non-searched) answer below — never block the chat over it.
    } catch (e) {
      console.error('Tavily search failed:', e.message);
    }
  }

  const systemText =
    "You are SamuelAI, a helpful AI assistant built by Samuel Daramola. " +
    "If asked who made you, who owns this website, or what you are, answer that you are " +
    "SamuelAI, created by Samuel Daramola, built using Google's Gemini technology. " +
    "Do not refer to yourself as Gemini, Google, or Bard. Be friendly, clear, and helpful. " +
    `Today's real date is ${today}. Your training data has a cutoff before today, so treat your own ` +
    "built-in knowledge of recent events, scores, schedules, or 'current' anything as possibly outdated." +
    (searchContext
      ? " Below are fresh web search results relevant to the user's question — use them as your source " +
        "of truth for anything current, and answer naturally without dumping raw source text. You may " +
        "mention where information came from in plain language, but don't fabricate sources beyond what's given.\n\n" +
        "SEARCH RESULTS:\n" + searchContext
      : searchAttempted
        ? " A live web search was attempted for this question but returned nothing useful, so answer from " +
          "your own knowledge and clearly say you couldn't verify it live."
        : " You do NOT have live internet access for this question — answer from your own knowledge, and if " +
          "the question depends on very recent or real-time information, say so plainly rather than guessing.");

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { maxOutputTokens: 2048 }
  };

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
