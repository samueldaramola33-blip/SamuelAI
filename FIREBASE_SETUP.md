# Setting up accounts (Firebase) for SamuelAI

This adds: Login/signup (Email, Google, Microsoft), saved chat history per user, theme preference saved per user, and a dashboard where you can see everyone who signs up.

## 1. Create a Firebase project (free)

1. Go to https://console.firebase.google.com and sign in with your Google account.
2. Click **"Add project"**, name it (e.g. "SamuelAI"), and finish the setup wizard (you can skip Google Analytics if asked).

## 2. Register a Web App

1. On your new project's dashboard, click the **`</>`** (web) icon to add a web app.
2. Give it a nickname (e.g. "SamuelAI Web"), click **Register app**.
3. Firebase will show you a `firebaseConfig` object like this:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "samuelai-xxxxx.firebaseapp.com",
     projectId: "samuelai-xxxxx",
     storageBucket: "samuelai-xxxxx.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef123456"
   };
   ```
4. Copy this whole object.

## 3. Paste your config into index.html

1. Open `index.html`, find this near the top of the `<script type="module">` section:
   ```js
   const firebaseConfig = {
     apiKey: "YOUR_FIREBASE_API_KEY",
     authDomain: "YOUR_PROJECT.firebaseapp.com",
     projectId: "YOUR_PROJECT_ID",
     storageBucket: "YOUR_PROJECT.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   ```
2. Replace it with the real config you copied in step 2. (This is safe to have visible in your site's code — it's a public app identifier, not a secret.)

## 4. Turn on sign-in methods

1. In the Firebase console, go to **Build → Authentication → Get started**.
2. Under the **Sign-in method** tab, enable:
   - **Email/Password** — just toggle it on, click Save.
   - **Google** — toggle on, pick a support email, Save.
   - **Microsoft** — toggle on. This one needs an extra step:
     a. Go to https://portal.azure.com (free Microsoft account works) → **Azure Active Directory → App registrations → New registration**.
     b. Name it anything, set **Redirect URI** to the value Firebase shows you on the Microsoft provider screen (looks like `https://YOUR_PROJECT.firebaseapp.com/__/auth/handler`).
     c. After creating it, copy the **Application (client) ID**, then go to **Certificates & secrets → New client secret**, copy that value too.
     d. Paste both the Client ID and Client Secret into Firebase's Microsoft provider screen, and Save.

## 5. Turn on Firestore (the database)

1. In the Firebase console, go to **Build → Firestore Database → Create database**.
2. Choose **Start in production mode**, pick a location close to your users, click Enable.
3. Go to the **Rules** tab and replace the rules with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
         match /sessions/{sessionId} {
           allow read, write: if request.auth != null && request.auth.uid == userId;
         }
       }
       // Feedback (👍/👎 on responses) — anyone can submit feedback, including
       // guests who aren't signed in, but nobody can read, edit, or delete
       // other people's feedback entries from the client. You'll view these
       // yourself in the Firebase console's Firestore data browser.
       match /feedback/{feedbackId} {
         allow create: if true;
         allow read, update, delete: if false;
       }
     }
   }
   ```
   This makes sure each user can only ever read or write their own chat data — nobody can see anyone else's chats — while still letting anyone submit feedback.
4. Click **Publish**.

## 6. Add your Vercel domain to Firebase's allowed list

1. In Firebase console → Authentication → Settings → **Authorized domains**.
2. Add your Vercel domain (e.g. `samuel-ai-one.vercel.app`) if it's not already listed.

## 7. Deploy as usual

Replace your `index.html` on Vercel with the new one, redeploy. Login/signup should now work.

## Where to see your users

Firebase console → **Build → Authentication → Users** tab. You'll see every signed-up user's email, sign-in provider, and creation date — no extra coding needed.

## A few honest notes

- **File attachments in chat are not saved permanently** — only the text and any web sources are stored in a user's history. This keeps saved chats small and fast; re-attach a file if you revisit an old conversation about it.
- **Guest users** (not logged in) keep working exactly as before — nothing saved, resets on refresh. Logging in is optional, not required to use the site.
- **If someone chats as a guest, then logs in**, their guest conversation doesn't automatically move into their account — only chats sent *while* logged in are saved. This is a reasonable first-version limitation, not a bug.
- Firebase's free tier is generous (50,000 monthly active users, 1GB storage, 50k document reads/day) — comfortably enough for a small-to-medium site.
