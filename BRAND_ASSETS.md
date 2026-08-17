# SamuelAI brand assets — what's new and where it goes

## What was added
- A real logo mark: a 6-blade camera-aperture icon in your gold palette (replaces the plain circle outline that was there before)
- `favicon.ico`, `icon-32.png`, `icon-180.png`, `icon-192.png`, `icon-512.png` — the logo rendered at every size browsers/phones need
- `og-image.png` — the image that shows up when you share your site's link on WhatsApp, Twitter/X, LinkedIn, Facebook, etc.
- `logo.svg` — the master vector file, in case you want to reuse it elsewhere (business card, social profile picture, etc.)
- 4 clickable example prompts on the empty chat screen, so first-time visitors immediately see what to try
- Updated page `<title>`/description and social preview text

## Where these files go

All the new image files sit in the **root** of your project folder — directly next to `index.html`, not inside `api`:

```
samuelai/
├── index.html          ← updated
├── favicon.ico          ← new
├── icon-32.png           ← new
├── icon-180.png          ← new
├── icon-192.png          ← new
├── icon-512.png          ← new
├── og-image.png          ← new
├── logo.svg              ← new (optional, just a source file)
└── api/
    ├── chat.js
    └── imagine.js
```

`index.html` already has the correct code pointing to all of these — you don't need to edit anything, just make sure the files are sitting in the right place before you re-upload.

## To apply
1. Download all the files above into your `samuelai` folder (matching the layout shown), being careful with exact filenames as usual (no `(2)`, etc.)
2. Re-upload the whole folder to Vercel
3. Redeploy

## How to check it worked
- **Favicon**: look at your browser tab — you should see the gold aperture icon instead of a blank page icon
- **Social preview**: paste your site's link into a WhatsApp chat to yourself, or use a checker tool like https://www.opengraph.xyz/ and enter your site URL — you should see the full `og-image.png` card with the logo, name, and tagline
- **Example prompts**: open a new chat — you should see 4 clickable suggestion chips under the welcome text

## A couple of honest notes
- Social platforms (especially WhatsApp) aggressively cache link previews. If you tested sharing your link before adding this, you may need to share it from a slightly different URL, or use a cache-buster like `?v=2` at the end, the first time — after that it should show the new image normally.
- The logo is original artwork built specifically for this project (not copied from anywhere), so you're free to use it however you like.
