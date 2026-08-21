# Deploying Inkwell for free — with live sync and no data loss

This guide gets Inkwell onto the internet at a `https://…onrender.com` URL that
both your laptop and tablet can open, with:

- **Live sync** — ink and typing stream between devices over WebSocket
- **Durable data** — notes live in a free MongoDB Atlas database, so nothing is
  lost when the server sleeps, restarts, or redeploys, or when you close every
  browser

Total time: about 25 minutes. Everything below is on free tiers with no card
charge (Render's free plan needs no card; Atlas M0 is free forever).

You'll create three free accounts: **MongoDB Atlas** (the database),
**GitHub** (holds the code), **Render** (runs the server).

---

## Part A — Create the free database (MongoDB Atlas)

This is what makes your notes permanent.

1. Go to https://www.mongodb.com/cloud/atlas/register and sign up (Google
   sign-in works).
2. When asked to deploy a cluster, choose the **M0 Free** tier.
   Pick any provider/region close to you (e.g. AWS / Mumbai). Name it
   `inkwell` (any name is fine). Click **Create Deployment**.
3. **Database user** — Atlas shows a "Connect to your cluster" step:
   - Username: `inkwell`
   - Password: click **Autogenerate** and **copy it somewhere safe**
   - Click **Create Database User**
4. **Network access** — the server's IP changes on free hosting, so allow all:
   - Left sidebar → **Network Access** → **Add IP Address** →
     **Allow access from anywhere** (`0.0.0.0/0`) → Confirm.
   - (Safe here: the database still requires the username + password.)
5. **Connection string** — sidebar → **Clusters** → **Connect** →
   **Drivers** → copy the string. It looks like:

   ```
   mongodb+srv://inkwell:<db_password>@inkwell.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

   Replace `<db_password>` with the password from step 3 (no `<` `>`).
   Keep this whole line handy — it's your `MONGODB_URI`.

---

## Part B — Put the code on GitHub (private)

1. Sign up / sign in at https://github.com and create a **New repository**:
   name `inkwell`, visibility **Private** (important — the repo will contain
   your app), no README. 
2. On your computer, open a terminal in the `inkwell-web` folder (the one with
   `server.js`) and run:

   ```bash
   git init
   git add .
   git commit -m "Inkwell hosted edition"
   git branch -M main
   git remote add origin https://github.com/<your-username>/inkwell.git
   git push -u origin main
   ```

   (`.gitignore` already excludes `node_modules/` and local data.)

---

## Part C — Deploy on Render (free)

1. Sign up at https://render.com with your GitHub account.
2. Dashboard → **New +** → **Blueprint**. Authorize Render to see your
   `inkwell` repo and select it. Render reads `render.yaml` automatically.
3. It will ask for the two secret values:
   - **INKWELL_PASS** → type a **new** password of your choosing.
     Don't reuse `Iiitian149@` — it's written in this repo and chat, so treat
     it as public. This is the password you'll type on the login page.
   - **MONGODB_URI** → paste the connection string from Part A step 5.
4. Click **Apply / Deploy**. The first build takes 2–4 minutes.
5. When it says **Live**, open the URL (like `https://inkwell.onrender.com`).
   You should see the Inkwell sign-in page. Check the service **Logs** — you
   should see:

   ```
   Inkwell listening on :10000
   Storage: MongoDB
   ```

   If it says `Storage: files (...)` the MONGODB_URI variable didn't reach the
   service — add it under the service's **Environment** tab and redeploy.

---

## Part D — Connect the laptop and the tablet

1. On the **laptop**: open the URL in Chrome, sign in with `mahasin` + the
   password you set in Part C.
2. On the **tablet**: open the same URL in Chrome, sign in the same way.
   Tip: use the browser's "Add to Home screen" so it opens like an app.
3. Bottom-left of the laptop should now read **● 2 devices** (open ☰ on the
   tablet to see it there).
4. Test: turn on **✎ Ink** on the tablet and draw — the stroke should appear
   on the laptop while the pen is still moving. Type on the laptop — it should
   appear on the tablet. Ink and text both save to Atlas automatically; there
   is no "save" button to press, and closing every browser loses nothing.

---

## Part E — About sleeping, and keeping it awake (optional)

Render's free web services **spin down after ~15 minutes with no traffic**.
Nothing is lost — your notes are in Atlas — but the next visit takes ~30–60 s
to wake the server, and live sync resumes once it's awake.

If you want it always ready:

1. Sign up free at https://uptimerobot.com.
2. **Add New Monitor** → type **HTTP(s)** →
   URL: `https://<your-app>.onrender.com/healthz` → interval **5 minutes**.
3. That ping keeps the service warm. One always-on service uses ~720 instance
   hours a month, within Render's free allowance of 750.

`/healthz` is a public endpoint that returns `{ok:true}` and touches no data.

---

## Part F — Prove to yourself that data can't be lost

1. Write a note, draw on it, then close **every** browser tab. Reopen → it's
   all there (the data never lived in the browser).
2. In Render: **Manual Deploy → Deploy latest commit**. This rebuilds the
   server from scratch — the free tier's disk is wiped. When it's live again,
   sign in → everything is still there, because it's in Atlas, not on the disk.
3. Extra safety: the **Export** button downloads any note as `.md`, and Atlas
   itself is replicated storage. If you ever want a full raw backup, Atlas →
   cluster → **…** → you can also use `mongodump` locally.

---

## Updating the app later

Any time you change the code:

```bash
git add . && git commit -m "change" && git push
```

Render redeploys automatically on push. Your data is untouched (it's in Atlas).

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| First open takes ~1 minute | Free service was asleep — normal. Add the UptimeRobot ping (Part E). |
| `Storage: files (...)` in logs | `MONGODB_URI` missing/typo'd. Service → Environment → fix → redeploy. |
| Login always fails | You're typing the old password; use the `INKWELL_PASS` you set in Render. |
| `MongoServerSelectionError` in logs | Atlas Network Access must include `0.0.0.0/0` (Part A step 4), and the password in the URI must be the *database user's* password, URL-encoded if it has special characters (`@` → `%40`). |
| Devices show "1 device" each | They're on different URLs (e.g. one on an old deploy preview). Both must use the main service URL. |
| Sync stops after tablet locks | Mobile browsers pause background tabs; reopening the tab reconnects and re-fetches automatically. |

## What runs where (mental model)

```
laptop Chrome ──┐                       ┌── MongoDB Atlas (free, permanent)
                ├── Render web service ─┤     notebooks + notes + ink
tablet Chrome ──┘    (Node + Socket.IO) └── (survives restarts/redeploys)
```

The Render service is stateless — it can die, sleep, or redeploy at any time
and nothing is lost. The browsers are stateless too. Atlas is the single
source of truth.
