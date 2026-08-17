# Getting SamuelAI live — no coding required

You have 3 files:
- `index.html` — the website visitors see
- `api/chat.js` — handles chat, keeps your Gemini key secret
- `api/imagine.js` — handles image generation, keeps your Gemini key secret

## Steps

1. **Get a free Gemini API key**
   Go to https://aistudio.google.com/apikey and create one. Copy it — you'll paste it once in step 4, nowhere else.

2. **Create a free Vercel account**
   Go to https://vercel.com and sign up (GitHub, Google, or email all work).

3. **Upload your project**
   - Click "Add New" → "Project"
   - Choose "Deploy without Git" / drag-and-drop, and drop in the folder containing `index.html` and the `api` folder together
   - Vercel automatically detects the files in `api/` as serverless functions — you don't need to configure anything

4. **Add your API key as an environment variable**
   - In your new Vercel project, go to **Settings → Environment Variables**
   - Add a variable named `GEMINI_API_KEY` and paste your key as the value
   - Save, then redeploy (Vercel will prompt you, or click "Redeploy" in the Deployments tab)

5. **Visit your site**
   Vercel gives you a free URL like `samuelai.vercel.app`. Share that with anyone — they can chat and generate images with no sign-up and no key of their own.

## Adjusting limits

Each visitor is capped at:
- 60 chat messages/day (in `api/chat.js`, the `DAILY_LIMIT` constant)
- 10 images/day (in `api/imagine.js`, the `DAILY_LIMIT` constant)

Change those numbers if you want to be more or less generous — images cost real money per generation, so keep that one conservative until you know your traffic.

## A note on the current limiter

The per-visitor limit tracks by IP address in the server's memory. It resets whenever Vercel restarts your function (which happens periodically) and doesn't share counts across regions. That's fine for a small/personal site. If this grows into something with real traffic, tell me and I'll swap it for a proper shared counter (Vercel KV or Upstash — still free at small scale) so limits hold reliably.

## Custom domain (optional)

If you own a domain name, Vercel's project settings let you attach it for free — your site can then live at your own `.com` instead of the `vercel.app` address.
