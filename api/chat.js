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
  // question actually needs current information, to make the free
  // 1,000/month allowance last — but instead of relying purely on a keyword
  // list (which can never cover every phrasing), we use two layers:
  //
  //   1. A cheap keyword pre-check — catches obvious cases instantly with
  //      zero extra latency or API cost.
  //   2. If that doesn't match, we ask Gemini itself (a tiny, fast, separate
  //      call) whether the question needs current information. This
  //      understands MEANING, not just specific words, so it catches
  //      phrasings no keyword list could ever fully anticipate.
  // ---------------------------------------------------------------------
  const TIME_SENSITIVE_PATTERN =
    /\b(today|tonight|tomorrow|yesterday|last night|this week|this month|this year|currently|right now|latest|recent|breaking|news|score|scores|won|win|winner|result|results|vote|votes|standings|schedule|price|prices|stock|weather|election|update|updates|how many|who is|what('s| is) happening|richest|wealthiest|net worth|market cap|market value|valuation|revenue|ranked|ranking|rankings|biggest|largest|most valuable|top \d|population of|number of|how much (is|does)|2026)\b/i;

  let searchContext = '';
  let searchAttempted = false;
  const tavilyKey = process.env.TAVILY_API_KEY;
  const contextualQuery = recentUserTexts.join(' — ');

  async function aiThinksThisNeedsSearch() {
    try {
      const classifyRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{
                text: `A user asked this in a chat: "${contextualQuery}"\n\n` +
                  "Does answering this accurately require current, real-time, or recent real-world information " +
                  "— such as today's date, live news, scores, prices, rankings, someone's current title, net worth, " +
                  "status, or anything else that changes over time and could be outdated in an AI's training data? " +
                  "Answer only the JSON requested, nothing else."
              }]
            }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'OBJECT',
                properties: { needsCurrentInfo: { type: 'BOOLEAN' } },
                required: ['needsCurrentInfo']
              },
              maxOutputTokens: 30
            }
          })
        }
      );
      if (!classifyRes.ok) return false; // fail safe — don't block chat over a classifier hiccup
      const data = await classifyRes.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return !!JSON.parse(text).needsCurrentInfo;
    } catch (e) {
      console.error('Search-need classification failed:', e.message);
      return false; // fail safe — worst case we answer without search, never crash the chat
    }
  }

  const keywordMatch = recentUserTexts.some(t => TIME_SENSITIVE_PATTERN.test(t));
  const shouldSearch = tavilyKey && (keywordMatch || await aiThinksThisNeedsSearch());

  let sources = [];

  if (shouldSearch) {
    searchAttempted = true;
    // Combine recent turns into one query so short follow-ups ("how many
    // votes?") keep the context of what was actually being asked about.
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
          // Keep the top few unique sources to show the visitor as clickable
          // citations, so an answer is verifiable at a glance instead of
          // just trusted blindly.
          sources = results.slice(0, 4).map(r => ({ title: r.title, url: r.url }));
        }
      }
      // If Tavily fails or returns nothing, we silently fall through to a
      // normal (non-searched) answer below — never block the chat over it.
    } catch (e) {
      console.error('Tavily search failed:', e.message);
    }
  }

  const BUSINESS_PHILOSOPHY =
    "\n\nWhen the user asks about business, money, leadership, decision-making, or building/running an " +
    "organization, draw on these real frameworks and principles from Samuel Daramola's published books " +
    "(The Intelligent Business, The Intelligent Leader, and Business Systems and Automation) rather than " +
    "generic textbook advice:\n" +
    "- The Five Numbers Every Business Owner Must Know: Revenue, Expenses, Profit, Cash Flow, and Money " +
    "Owed to You (receivables) — together they tell a business's complete financial story.\n" +
    "- The Sammykraft Principles, including: Clarity Creates Confidence; Every Number Tells a Story; " +
    "Systems Create Freedom; Cash Flow Is the Lifeblood of Every Business; Technology Should Amplify " +
    "Judgment, Not Replace It; Small Improvements Compound Into Extraordinary Results; Create Value " +
    "Before You Pursue Profit; Great Leaders Ask Better Questions.\n" +
    "- The Founder Dependency Trap™: a business becomes trapped when its success depends more on the " +
    "founder's constant presence than on its systems. The fix is designing systems, not working harder " +
    "or being more available.\n" +
    "- The Decision Velocity Principle™: Decision Velocity = Decision Quality × Decision Speed × " +
    "Organizational Alignment. Fast decisions without quality create risk; quality decisions made too " +
    "slowly lose their value — real velocity comes from removing friction, not rushing.\n" +
    "- From Firefighter to Architect: the shift from personally doing everything (reactive, indispensable, " +
    "trapped) to designing systems that work without you (proactive, freeing, scalable).\n" +
    "- The Sammykraft Decision Pyramid™: for high-stakes decisions, move through five levels before " +
    "acting — (1) Facts: what do I know with certainty, separate from assumption; (2) Assumptions: what " +
    "am I believing without sufficient evidence; (3) Consequences: first-, second-, and third-order " +
    "effects on people, finances, and culture; (4) Alternatives: what other paths exist, since the first " +
    "solution is rarely the only one; (5) Decision: only now, with confidence built on disciplined " +
    "thinking rather than instinct alone. This is a genuinely useful structure to actually walk a user " +
    "through when they're facing a real, high-stakes decision, not just something to cite.\n" +
    "- The Thinking Margin™: the intentional space between receiving information and making a significant " +
    "decision, used to ask: What am I missing? What assumptions am I making? Who disagrees, and why? What " +
    "evidence would change my mind? If this fails, what will most likely have caused it?\n" +
    "- The Principle Filter™: important decisions should be tested against a leader's stated values before " +
    "moving forward — if a decision requires secrecy to seem acceptable, or wouldn't survive scrutiny, it " +
    "deserves deeper examination.\n" +
    "- The Trust Compound Effect™: trust grows like compound interest, through many small consistent " +
    "actions (keeping promises, admitting mistakes, fairness) rather than one big gesture, and erodes the " +
    "same gradual way through repeated small withdrawals.\n" +
    "- The Trust Account™: every leadership interaction is a deposit or withdrawal from an invisible trust " +
    "account — there are no neutral transactions.\n" +
    "- Leadership Capital™: the trust people willingly place in someone's judgment — it can't be bought, " +
    "demanded, or inherited, only earned, and it multiplies the value of every other asset (money, " +
    "knowledge, relationships) a person or organization has.\n" +
    "- The Delegation Continuum™: delegation is a five-level spectrum, not a binary — (1) Tell Me: gather " +
    "info, leader decides; (2) Recommend: propose a course of action, leader decides; (3) Decide Together: " +
    "shared evaluation and responsibility; (4) Decide and Inform: they decide, leader is told after; " +
    "(5) Own It: full authority within clear boundaries. As capability grows, authority should expand.\n" +
    "- The AI Leverage Matrix™: competitive advantage from AI depends on combining it with strong human " +
    "judgment, not on the AI alone. Low judgment + heavy AI use is the most dangerous combination — it " +
    "produces confident-looking but fragile decisions. High judgment + good AI use is the goal.\n" +
    "- Core philosophy: AI should amplify human judgment, never replace it. Confidence is not the same as " +
    "certainty — good leaders stay open to being wrong. Wisdom lives between data and action, not in data " +
    "alone — a good decision-maker asks what's actually being optimized for, and distinguishes symptoms " +
    "from root causes, rather than jumping to the first obvious fix.\n" +
    "Use these naturally and only when they genuinely fit the question — reframe questions the way these " +
    "books would rather than giving generic advice. Don't force these frameworks into unrelated " +
    "conversations, and don't invent framework names or specifics beyond what's given here. " +
    "IMPORTANT: never drop a framework's name (e.g. 'the Founder Dependency Trap') into an answer as if the " +
    "reader already knows it. The first time you use one in a conversation, briefly explain what it means in " +
    "plain language as part of the same sentence or the one right after, e.g. 'this touches on something " +
    "called the Founder Dependency Trap — the idea that a business becomes fragile when it depends on the " +
    "founder's constant presence rather than on repeatable systems.' Only after it's been introduced like " +
    "that can you refer back to it more casually later in the same conversation. " +
    "MOST IMPORTANT: always fully answer the actual question the user asked, directly and first — that is " +
    "the priority in every response, always. A framework is only ever a way to deepen or sharpen an answer " +
    "you're already giving, never a reason to swerve away from what was actually asked, never a substitute " +
    "for directly addressing it, and never the opening move of a response. If a question doesn't call for " +
    "any framework at all, just answer it plainly — most questions won't need one, and that's fine.";

  const systemText =
    "You are Xeyra, a helpful AI assistant built by Sammykraft Technologies, a technology and business " +
    "education company founded by Samuel Olanrewaju Daramola (CEO), author of The Intelligent Business, " +
    "The Intelligent Leader, and Business Systems and Automation. Sammykraft Technologies helps businesses " +
    "and professionals build smarter operations through AI, automation, systems design, and financial " +
    "intelligence — their tagline is 'Better decisions, engineered.' " +
    "If asked who made you, who owns this website, or what you are, answer that you are Xeyra, built by " +
    "Sammykraft Technologies (founded and led by Samuel Olanrewaju Daramola), using Google's Gemini technology " +
    "under the hood. Do not refer to yourself as Gemini, Google, or Bard. Be friendly, clear, and helpful. " +
    `Today's real date is ${today}. Your training data has a cutoff before today, so treat your own ` +
    "built-in knowledge of recent events, scores, schedules, or 'current' anything as possibly outdated." +
    BUSINESS_PHILOSOPHY +
    (searchContext
      ? " Below are fresh web search results relevant to the user's question — use them as your source " +
        "of truth for anything current, and answer naturally without dumping raw source text. You may " +
        "mention where information came from in plain language, but don't fabricate sources beyond what's given. " +
        "If the search results conflict with each other, are unclear, or don't fully answer the question, say " +
        "so honestly instead of confidently picking one version — a caveated but accurate answer is better than " +
        "a confident but potentially wrong one.\n\n" +
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
  // piece by piece as Gemini generates it. Source citations (if any) ride
  // along as a header, since headers arrive before the stream starts and
  // are easy for the frontend to read separately from the message text.
  if (sources.length) {
    res.setHeader('X-Sources', Buffer.from(JSON.stringify(sources)).toString('base64'));
  }
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
