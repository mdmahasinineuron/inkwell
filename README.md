# Inkwell — hosted edition

The portable desktop app, converted to a web app you can open from any browser.
One account, many devices: open it on your laptop and your tablet at the same
time and they stay in step **live** — ink drawn on the tablet appears on the
laptop while the pen is still moving, and text typed on the laptop shows up on
the tablet as you type.

What's inside:

- **Login page** — a single user (default `mahasin`), no sign-up. Credentials
  come from env vars in production.
- **Code block inserter with a language picker** — `{ } Code block` opens a
  dialog with a 35-language dropdown; the block is inserted fenced and
  syntax-highlighted in the preview.
- **VS Code-style editing in the dialog** — Enter keeps the current indent and
  deepens it after `{`, `(`, `[` (and `:` in Python, opening tags in HTML);
  Tab / Shift+Tab indent or dedent whole selections; brackets and quotes
  auto-pair, wrap selections, and closers skip over or smart-dedent. Indent
  width follows the chosen language (2 spaces for HTML/CSS/JSON/YAML/Ruby…,
  4 for the rest).
- **Code tiles** — each block renders as a card that **shrinks to the width of
  its code**, leaving the rest of the paper free for handwriting. The header
  shows the language, a Copy button, and the block's **own text-size control**
  (`A−` / `A+`) that never touches the page text. **Drag the header bar to move
  the tile** anywhere on the paper (double-click the bar to snap it back);
  drag the bottom-right corner to resize it. Font size, position, and size are
  all saved with the note and sync live to the other device, so ink written
  next to a tile lines up the same everywhere.
- **Edit directly on the paper** — click any paragraph, heading, list, or
  quote on the page (Ink off) and a caret lands where you clicked: type,
  insert words mid-line, press Enter for a new line (leave a line blank for a
  new paragraph). A floating bar offers **B**old, *I*talic, and **A− / A+**
  text sizing — with a selection it sizes just the selected words, without one
  it sizes the whole block. Click a gap between blocks (or anywhere below the
  text) to start a new paragraph right there. Everything is written straight
  back into the Markdown source, so the editor pane updates as you type and
  the change streams live to the other device like any edit. Esc or clicking
  away finishes the edit.
- **Ink mode with a OneNote-style Draw ribbon** — turning Ink on docks a
  ribbon under the toolbar: undo/redo, Eraser, then a pen gallery of four pens
  and three chisel highlighters shown as vertical pen glyphs (the selected one
  rises, OneNote-style). Click the selected pen again for its dropdown with a
  Thickness row (five dot sizes) and a 16-color Ink Colors grid; each pen
  remembers its own customization per browser. Strokes are butter-smooth —
  input is exponentially smoothed and jitter-gated, and rendered as curved
  variable-width outlines with pressure shaping the line. Everything streams
  live to every connected device over WebSocket and is saved server-side.
- **Resizable partitions** — drag the divider between the notebooks rail and
  the notes list, between the notes list and the editor, and between the
  editor and the paper. Widths persist per browser.
- Notebooks, Markdown notes, live preview, search, export to `.md` **or PDF**
  (the PDF button opens the print dialog — pick "Save as PDF"; each on-screen
  A4 page maps to one PDF page, ink included).
- **Per-note page style** — creating a note asks which you want: **A4 pages**
  (traditional document: pages are added automatically as text or ink nears
  the bottom, and every boundary has a "＋ blank page" button that inserts an
  empty page there, shifting the text and ink below it down one page on every
  device) or **infinite scroll** (one endless sheet). The toolbar toggle
  switches an existing note between the two at any time, synced live.
- Blank lines are honored: leave 2, 10, or more empty lines in the editor and
  the paper shows the same vertical gap (code blocks are unaffected).
- **Independent scrolling with typing-follow** — the editor and the paper
  scroll freely on their own, but while you type, the paper auto-scrolls to
  the block your caret is in (with a dead zone so it never twitches). The
  paper always keeps extra blank room past the end of the text for
  handwriting.
- **Paper-first on tablets** — on narrow screens the app opens straight onto
  the writing surface; the notebooks and notes panels slide in from the left
  via the ☰ button (tap a note or the dimmed page to slide them away), and
  `¶ Write` switches to the Markdown editor when you want to type.
- Same storage layout as before: `inkwell-data/notebooks.json` +
  `inkwell-data/notes/<id>.json`, atomic writes.

## Run locally

```bash
npm install
npm start          # http://localhost:3000  → sign in: mahasin / Iiitian149@
```

Open it in two browser windows to watch the sync.

## Deploy for free (durable data)

Follow **[DEPLOY.md](DEPLOY.md)** — a complete step-by-step guide that pairs
Render's free tier with a free MongoDB Atlas database, so live sync works and
no data is ever lost to restarts, redeploys, or closing the browser. Set
`MONGODB_URI` and the server switches from file storage to MongoDB
automatically (the log line says which one is active).

## Deploy on Render (free tier) — short version

1. Push this folder to a GitHub repo (**private** — see the security note below).
2. On https://render.com → **New → Blueprint**, pick the repo. Render reads
   `render.yaml` and creates the service.
3. When prompted, enter `INKWELL_PASS` (your password). `SESSION_SECRET` is
   generated automatically.
4. Deploy. You get a URL like `https://inkwell.onrender.com` — open it on the
   laptop and the tablet, sign in on both, done.

WebSockets work on Render's free tier, so live sync works out of the box.

### Free-tier caveats (read this)

- **Sleep:** free services spin down after ~15 min idle; the first request
  afterwards takes ~30–60 s to wake. Sync is instant once awake.
- **Storage:** the free tier's disk is **ephemeral** — notes survive normal
  running but are wiped on each **deploy/restart**. Options:
  - Use **Export** to keep `.md` backups (free, manual).
  - Attach a Render **persistent disk** to the service and set
    `DATA_DIR=/data/inkwell` (small monthly cost, fully durable).
  - Or host on a free VM (e.g. Oracle Cloud always-free) where the filesystem
    is durable: `node server.js` behind any reverse proxy is all it needs.

### Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `INKWELL_USER` | `mahasin` | Login username |
| `INKWELL_PASS` | *(built-in dev default)* | Login password — **always set this in production** |
| `SESSION_SECRET` | random per boot | Cookie signing key; set it so logins survive restarts |
| `DATA_DIR` | `./inkwell-data` | Where notes are stored |
| `PORT` | `3000` | Listen port (Render sets this) |

## Security note

The default password exists only so `npm start` works out of the box. Since it
has now been written down (in chat and in this repo), treat it as public:
**set a different `INKWELL_PASS` on the host**, and keep the repo private.
The app itself never stores the password on disk.

## How sync works

- Every browser opens one authenticated Socket.IO connection.
- Ink: `ink:begin` → `ink:points` (batched ~every 40 ms) → `ink:end`. Other
  devices draw the stroke as the points arrive; the server persists the
  finished stroke into the note's JSON. Eraser/undo send `ink:remove`.
- Text: keystrokes are relayed live (`note:typing`, throttled 150 ms) and a
  debounced save (600 ms) writes the note to disk. Last write wins; if both
  devices type in the same note at the same instant, the most recent edit
  sticks.
- Ink coordinates are stored in a fixed 820-px logical page space, so a stroke
  lands in the identical spot on any screen size.

## Layout

```
server.js          Express + Socket.IO: auth, JSON storage, sync relay
public/login.html  Sign-in page
public/index.html  App shell
public/styles.css  Drafting-desk theme
public/app.js      Editor, markdown, code dialog, ink engine, sync client
render.yaml        One-click Render blueprint
```
