// Inkwell — hosted edition.
// Storage backends:
//   • Files (default): DATA_DIR/notebooks.json + DATA_DIR/notes/<id>.json
//   • MongoDB (set MONGODB_URI): durable free storage for hosts with
//     ephemeral disks (e.g. Render's free tier). Same data shape.
// Plus: single-user login and a Socket.IO relay so every open browser
// (laptop, tablet, ...) sees edits and ink strokes live.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

// ---------------------------------------------------------------- config ---
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'inkwell-data');

// Single-user login. Override on the host with env vars — don't ship real
// credentials in a public repo.
const AUTH_USER = process.env.INKWELL_USER || 'mahasin';
const AUTH_PASS = process.env.INKWELL_PASS || 'Iiitian149@';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const safeId = (id) => typeof id === 'string' && /^[\w-]+$/.test(id);

// Serialize writes per note so racing saves (two devices) can't interleave.
const writeQueues = new Map();
function queued(id, fn) {
  const prev = writeQueues.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(id, next.finally(() => {
    if (writeQueues.get(id) === next) writeQueues.delete(id);
  }));
  return next;
}

const noteMeta = (n) => ({
  id: n.id, notebookId: n.notebookId, title: n.title,
  updated: n.updated, created: n.created,
  preview: (n.body || '').slice(0, 120),
  hasInk: Array.isArray(n.strokes) && n.strokes.length > 0
});

// ------------------------------------------------------- file storage -----
function fileStore() {
  const NOTES_DIR = path.join(DATA_DIR, 'notes');
  const NOTEBOOKS_FILE = path.join(DATA_DIR, 'notebooks.json');
  const noteFile = (id) => path.join(NOTES_DIR, id + '.json');

  async function readJSON(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch { return fallback; }
  }
  // Atomic-ish write: temp file + rename, so a crash never truncates a note.
  async function writeJSON(file, data) {
    const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, file);
  }

  return {
    kind: 'files (' + DATA_DIR + ')',
    async init() {
      await fsp.mkdir(NOTES_DIR, { recursive: true });
      try { await fsp.access(NOTEBOOKS_FILE); }
      catch {
        await writeJSON(NOTEBOOKS_FILE,
          [{ id: 'nb-' + Date.now(), title: 'My Notebook', created: Date.now() }]);
      }
    },
    getNotebooks: () => readJSON(NOTEBOOKS_FILE, []),
    saveNotebooks: (nbs) => writeJSON(NOTEBOOKS_FILE, nbs),
    async listNotes() {
      const files = await fsp.readdir(NOTES_DIR);
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const n = await readJSON(path.join(NOTES_DIR, f), null);
        if (n) out.push(noteMeta(n));
      }
      return out;
    },
    getNote: (id) => readJSON(noteFile(id), null),
    saveNote: (note) => queued(note.id, () => writeJSON(noteFile(note.id), note)),
    deleteNote: (id) => queued(id, () => fsp.unlink(noteFile(id)).catch(() => {})),
    mutateNote: (id, fn) => queued(id, async () => {
      const n = await readJSON(noteFile(id), null);
      if (!n) return;
      fn(n);
      n.updated = Date.now();
      await writeJSON(noteFile(id), n);
    })
  };
}

// ---------------------------------------------------- mongodb storage -----
function mongoStore(uri) {
  const { MongoClient } = require('mongodb');
  let notes, notebooks;
  return {
    kind: 'MongoDB',
    async init() {
      const client = new MongoClient(uri);
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'inkwell');
      notes = db.collection('notes');
      notebooks = db.collection('notebooks');
      const existing = await notebooks.findOne({ _id: 'notebooks' });
      if (!existing) {
        await notebooks.insertOne({ _id: 'notebooks',
          items: [{ id: 'nb-' + Date.now(), title: 'My Notebook', created: Date.now() }] });
      }
    },
    async getNotebooks() {
      const doc = await notebooks.findOne({ _id: 'notebooks' });
      return (doc && doc.items) || [];
    },
    saveNotebooks: (nbs) =>
      notebooks.updateOne({ _id: 'notebooks' }, { $set: { items: nbs } }, { upsert: true }),
    async listNotes() {
      const docs = await notes.aggregate([{
        $project: {
          _id: 0, id: '$_id', notebookId: 1, title: 1, updated: 1, created: 1,
          preview: { $substrCP: [{ $ifNull: ['$body', ''] }, 0, 120] },
          hasInk: { $gt: [{ $size: { $ifNull: ['$strokes', []] } }, 0] }
        }
      }]).toArray();
      return docs;
    },
    async getNote(id) {
      const d = await notes.findOne({ _id: id });
      if (!d) return null;
      const { _id, ...rest } = d;
      return { id: _id, ...rest, id: _id };
    },
    saveNote: (note) => queued(note.id, () => {
      const { id, ...rest } = note;
      return notes.replaceOne({ _id: id }, { _id: id, ...rest, id }, { upsert: true });
    }),
    deleteNote: (id) => queued(id, () => notes.deleteOne({ _id: id })),
    mutateNote: (id, fn) => queued(id, async () => {
      const d = await notes.findOne({ _id: id });
      if (!d) return;
      fn(d);
      d.updated = Date.now();
      await notes.replaceOne({ _id: id }, d);
    })
  };
}

const store = process.env.MONGODB_URI ? mongoStore(process.env.MONGODB_URI) : fileStore();

// ------------------------------------------------------------------- app ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1); // behind Render/railway/fly proxy
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
  }
});
app.use(sessionMiddleware);
app.use(express.json({ limit: '15mb' })); // notes with lots of ink can be chunky

function timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- auth pages / endpoints (public) ----
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const ok = timingSafeEqual(username || '', AUTH_USER) &&
             timingSafeEqual(password || '', AUTH_PASS);
  if (!ok) return res.status(401).json({ ok: false, error: 'Wrong username or password.' });
  req.session.user = AUTH_USER;
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// health endpoint for uptime pingers (never sleeps behind auth)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- everything below requires a session ----
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login');
}

app.get('/', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Static assets (css/js) are fine to serve unauthenticated; data is not.
// Keep the app shell itself behind the session too.
app.get('/index.html', requireAuth, (_req, res) => res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const api = express.Router();
api.use(requireAuth);

api.get('/notebooks', async (_req, res) => res.json(await store.getNotebooks()));

api.put('/notebooks', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected an array' });
  await store.saveNotebooks(req.body);
  broadcast(req, 'notebooks:changed', req.body);
  res.json({ ok: true });
});

api.get('/notes', async (_req, res) => {
  const notes = await store.listNotes();
  notes.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  res.json(notes);
});

api.get('/notes/:id', async (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const n = await store.getNote(req.params.id);
  if (!n) return res.status(404).json({ error: 'Not found' });
  res.json(n);
});

api.put('/notes/:id', async (req, res) => {
  const id = req.params.id;
  const note = req.body;
  if (!safeId(id) || !note || note.id !== id) return res.status(400).json({ error: 'Bad note' });
  await store.saveNote(note);
  broadcast(req, 'note:saved', {
    id, notebookId: note.notebookId, title: note.title, body: note.body,
    codeTiles: note.codeTiles, updated: note.updated, created: note.created
  });
  res.json({ ok: true });
});

api.delete('/notes/:id', async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: 'Bad id' });
  await store.deleteNote(id);
  broadcast(req, 'note:deleted', { id });
  res.json({ ok: true });
});

app.use('/api', api);

// -------------------------------------------------------------- realtime ---
// One user, many devices. We relay events to *other* sockets, so the sender
// never echoes to itself.

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const sess = socket.request.session;
  if (sess && sess.user) return next();
  next(new Error('unauthorized'));
});

// Map a REST request to the socket that made it (client sends its socket id)
// so REST-triggered broadcasts also skip the sender.
function broadcast(req, event, payload) {
  const senderId = req.get('x-socket-id');
  const sender = senderId && io.sockets.sockets.get(senderId);
  (sender ? sender.broadcast : io).emit(event, payload);
}

io.on('connection', (socket) => {
  // Presence: tell everyone how many devices are connected.
  const count = () => io.emit('presence', { devices: io.engine.clientsCount });
  count();
  socket.on('disconnect', count);

  // Live ink relay. begin/points stream in real time; end persists the stroke.
  socket.on('ink:begin', (msg) => socket.broadcast.emit('ink:begin', msg));
  socket.on('ink:points', (msg) => socket.broadcast.emit('ink:points', msg));

  socket.on('ink:end', async (msg) => {
    socket.broadcast.emit('ink:end', msg);
    const { noteId, stroke } = msg || {};
    if (!safeId(noteId) || !stroke || !stroke.id) return;
    await store.mutateNote(noteId, (n) => {
      n.strokes = Array.isArray(n.strokes) ? n.strokes : [];
      if (!n.strokes.some(s => s.id === stroke.id)) n.strokes.push(stroke);
    });
  });

  // Undo / eraser (remove whole strokes).
  socket.on('ink:remove', async (msg) => {
    socket.broadcast.emit('ink:remove', msg);
    const { noteId, strokeIds } = msg || {};
    if (!safeId(noteId) || !Array.isArray(strokeIds)) return;
    await store.mutateNote(noteId, (n) => {
      if (Array.isArray(n.strokes))
        n.strokes = n.strokes.filter(s => !strokeIds.includes(s.id));
    });
  });

  // Live text typing relay (fast path; the sender also PUTs a debounced save).
  socket.on('note:typing', (msg) => socket.broadcast.emit('note:typing', msg));

  // Structural change (blank page inserted / page mode flipped): tell the
  // other devices to refetch the note. Persistence already happened via PUT.
  socket.on('note:reload', (msg) => socket.broadcast.emit('note:reload', msg));
});

// ------------------------------------------------------------------ boot ---
store.init().then(() => {
  server.listen(PORT, () => {
    console.log(`Inkwell listening on :${PORT}`);
    console.log(`Storage: ${store.kind}`);
    if (!process.env.INKWELL_PASS) {
      console.log('Using the built-in default login — set INKWELL_USER / INKWELL_PASS env vars in production.');
    }
  });
}).catch((err) => {
  console.error('Storage failed to initialize:', err.message);
  process.exit(1);
});
