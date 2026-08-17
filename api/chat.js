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
    return { allowed: true, remaining: DAILY_LIMIT - 1 };
  }
  if (entry.count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: DAILY_LIMIT - entry.count };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const usageCheck = checkAndConsume(ip);
  res.setHeader('X-RateLimit-Remaining', String(usageCheck.remaining));
  res.setHeader('X-RateLimit-Limit', String(DAILY_LIMIT));
  if (!usageCheck.allowed) {
    return res.status(429).json({ error: `Daily limit reached (${DAILY_LIMIT} messages). Please try again tomorrow.` });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
  }

  const { contents, customInstructions } = req.body || {};
  if (!Array.isArray(contents)) {
    return res.status(400).json({ error: 'Missing conversation contents.' });
  }

  const model = process.env.TEXT_MODEL || 'gemini-3.5-flash-lite';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // Pull the last few user messages — used to decide whether to search
  // (a short follow-up like "how many votes?" has no trigger words of its
  // own, but is clearly still about the same topic) and to build a search
  // query that actually carries context instead of just the latest message.
  const recentUserTexts = contents
    .filter(c => c.role === 'user')
    .map(c => c.parts?.find(p => p.text)?.text || '')
    .filter(Boolean)
    .slice(-3); // last up to 3 user turns
  const lastUserText = recentUserTexts[recentUserTexts.length - 1] || '';

  // ---------------------------------------------------------------------
  // LIVE WEB SEARCH via Tavily (free, no billing required — unlike Gemini's
  // own Google Search grounding, which needs a billing-enabled account even
  // for its free monthly allowance). We only spend a search credit when the
  // question looks like it actually needs current information, to make the
  // free 1,000/month allowance last.
  // ---------------------------------------------------------------------
  const TIME_SENSITIVE_PATTERN =
    /\b(today|tonight|tomorrow|yesterday|last night|this week|this month|this year|currently|right now|latest|recent|breaking|news|score|scores|won|win|winner|result|results|vote|votes|standings|schedule|price|prices|stock|weather|election|update|updates|how many|who is (the )?(current|president|prime minister|ceo)|what('s| is) happening|2026)\b/i;

  let searchContext = '';
  let searchAttempted = false;
  const tavilyKey = process.env.TAVILY_API_KEY;

  // Search if the LATEST message matches directly, OR if an earlier recent
  // message matched (meaning we're likely still in a follow-up about that
  // same time-sensitive topic).
  const shouldSearch = tavilyKey && recentUserTexts.some(t => TIME_SENSITIVE_PATTERN.test(t));

  if (shouldSearch) {
    searchAttempted = true;
    // Combine recent turns into one query so short follow-ups ("how many
    // votes?") keep the context of what was actually being asked about.
    const contextualQuery = recentUserTexts.join(' — ');
    try {
      const tavilyRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: contextualQuery,
          search_depth: 'advanced',
          max_results: 7,
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
    "You are Loupe, a helpful AI assistant built by Samuel Daramola. " +
    "If asked who made you, who owns this website, or what you are, answer that you are " +
    "Loupe, created by Samuel Daramola, built using Google's Gemini technology. " +
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
          "the question depends on very recent or real-time information, say so plainly rather than guessing.") +
    (customInstructions && typeof customInstructions === 'string' && customInstructions.trim()
      ? "\n\nThe user has set these personal preferences for how you respond — follow them for every reply " +
        "in this conversation, as long as they don't conflict with being safe, honest, and helpful:\n" +
        customInstructions.trim().slice(0, 800) // safety cap so this can't be used to smuggle in a huge prompt
      : "");

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { maxOutputTokens: 2048 }
  };

  // Use Gemini's streaming endpoint (Server-Sent Events) so the visitor sees
  // the answer appear progressively, instead of waiting for the whole thing.
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  let geminiRes;
  try {
    geminiRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!geminiRes.ok) {
    let errData = {};
    try { errData = await geminiRes.json(); } catch (e) { /* ignore */ }
    return res.status(geminiRes.status).json(errData);
  }

  // From here on we're streaming plain text chunks straight to the browser —
  // this response is no longer JSON, it's just the raw answer text arriving
  // piece by piece as Gemini generates it.
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  });

  const reader = geminiRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotAnyText = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Gemini's SSE stream sends lines like: "data: {...json...}\n\n"
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete trailing line for next round

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const piece = parsed?.candidates?.[0]?.content?.parts
            ?.map(p => p.text).filter(Boolean).join('') || '';
          if (piece) {
            gotAnyText = true;
            res.write(piece);
          }
        } catch (e) {
          // Partial/incomplete JSON chunk — safe to skip, next chunk will complete it
        }
      }
    }
  } catch (err) {
    res.write(`\n\n[Connection interrupted: ${err.message}]`);
  }

  if (!gotAnyText) {
    res.write('(No response returned. Try rephrasing or asking again.)');
  }
  res.end();
}
