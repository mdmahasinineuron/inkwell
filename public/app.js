/* Inkwell — hosted client.
   One user, many devices: everything below keeps the laptop and the tablet
   showing the same page in real time (text via note:typing, ink streamed
   point-by-point via ink:begin/points/end). */

'use strict';

// ───────────────────────────── constants ─────────────────────────────────
const PAPER_W = 820; // logical ink coordinate width; strokes are stored in
                     // this space so they land identically on every device.

const LANGUAGES = [
  ['', 'Plain text'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
  ['python', 'Python'], ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'],
  ['csharp', 'C#'], ['go', 'Go'], ['rust', 'Rust'], ['kotlin', 'Kotlin'],
  ['swift', 'Swift'], ['php', 'PHP'], ['ruby', 'Ruby'], ['dart', 'Dart'],
  ['scala', 'Scala'], ['r', 'R'], ['sql', 'SQL'], ['bash', 'Bash / Shell'],
  ['powershell', 'PowerShell'], ['html', 'HTML'], ['css', 'CSS'],
  ['scss', 'SCSS'], ['json', 'JSON'], ['yaml', 'YAML'], ['xml', 'XML'],
  ['markdown', 'Markdown'], ['dockerfile', 'Dockerfile'], ['ini', 'INI / TOML'],
  ['diff', 'Diff'], ['graphql', 'GraphQL'], ['lua', 'Lua'], ['perl', 'Perl'],
  ['matlab', 'MATLAB'], ['latex', 'LaTeX'], ['plaintext', 'Other']
];

// ───────────────────────────── dom handles ───────────────────────────────
const $ = (s) => document.querySelector(s);
const notebookList = $('#notebook-list'), noteList = $('#note-list');
const titleEl = $('#title'), editor = $('#editor'), rendered = $('#rendered');
const paper = $('#paper'), paperFit = $('#paper-fit'), paperScroll = $('#paper-scroll');
const canvas = $('#ink-canvas'), ctx = canvas.getContext('2d');
const penTray = $('#pen-tray'), pressureOut = $('#pressure-readout');
const presenceEl = $('#presence');

// ───────────────────────────── state ─────────────────────────────────────
let notebooks = [];
let notesMeta = [];
let currentNotebookId = null;
let note = null;                 // full note currently open
let inkMode = false;
let tool = 'pen', color = '#1D3A6E', size = 3, palmReject = true;
let undoStack = [], redoStack = [];
let liveRemote = new Map();      // strokeId -> in-progress stroke from other device
let lastLocalInput = 0;          // guards against remote text clobbering typing
let saveTimer = null, typingTimer = null;

// ───────────────────────────── networking ────────────────────────────────
const socket = io();

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json', 'x-socket-id': socket.id || '' },
    ...opts
  });
  if (res.status === 401) { location.href = '/login'; return null; }
  if (!res.ok) throw new Error('API ' + res.status);
  return res.json();
}

socket.on('presence', ({ devices }) => {
  presenceEl.textContent = `● ${devices} device${devices === 1 ? '' : 's'}`;
  presenceEl.classList.toggle('solo', devices <= 1);
});

socket.on('notebooks:changed', (nbs) => { notebooks = nbs; renderNotebooks(); });

socket.on('note:saved', (meta) => {
  upsertMeta(meta);
  renderNotes();
  if (note && meta.id === note.id && !peSession && Date.now() - lastLocalInput > 1500) {
    note.title = meta.title; note.body = meta.body; note.updated = meta.updated;
    if (meta.codeTiles) note.codeTiles = meta.codeTiles;
    if (document.activeElement !== titleEl) titleEl.value = meta.title || '';
    if (document.activeElement !== editor) editor.value = meta.body || '';
    renderMarkdown();
  }
});

socket.on('note:deleted', ({ id }) => {
  notesMeta = notesMeta.filter(n => n.id !== id);
  renderNotes();
  if (note && note.id === id) { note = null; showNote(null); }
});

// another device restructured the note (blank page insert / page-mode flip)
socket.on('note:reload', async (msg) => {
  if (!msg) return;
  commitPaperEdit();
  if (note && msg.id === note.id) {
    const n = await api('/notes/' + msg.id);
    if (!n) return;
    n.strokes = Array.isArray(n.strokes) ? n.strokes : [];
    n.codeTiles = n.codeTiles && typeof n.codeTiles === 'object' ? n.codeTiles : {};
    if (n.pageMode !== 'infinite') n.pageMode = 'a4';
    note = n;
    if (document.activeElement !== titleEl) titleEl.value = n.title || '';
    if (document.activeElement !== editor) editor.value = n.body || '';
    pageModeLabel();
    renderMarkdown();
    redraw();
  }
  notesMeta = await api('/notes') || notesMeta;
  renderNotes();
});

// live keystrokes from the other device
socket.on('note:typing', (msg) => {
  if (!msg) return;
  upsertMeta({ ...msg, preview: (msg.body || '').slice(0, 120) });
  renderNotes();
  if (!note || msg.id !== note.id) return;
  if (peSession) return; // editing this note on the paper right now
  if (Date.now() - lastLocalInput < 1500) return; // I'm typing here; last write wins later
  note.title = msg.title; note.body = msg.body;
  if (msg.codeTiles) note.codeTiles = msg.codeTiles;
  if (document.activeElement !== titleEl) titleEl.value = msg.title || '';
  if (document.activeElement !== editor) editor.value = msg.body || '';
  renderMarkdown();
});

// live ink from the other device — draws mid-stroke
socket.on('ink:begin', (m) => {
  if (!note || m.noteId !== note.id) return;
  liveRemote.set(m.stroke.id, { ...m.stroke, points: [] });
});
socket.on('ink:points', (m) => {
  if (!note || m.noteId !== note.id) return;
  const s = liveRemote.get(m.strokeId);
  if (!s) return;
  s.points.push(...m.points);
  redraw();
});
socket.on('ink:end', (m) => {
  if (!note || m.noteId !== note.id) return;
  liveRemote.delete(m.stroke.id);
  if (!note.strokes.some(s => s.id === m.stroke.id)) note.strokes.push(m.stroke);
  markInk(note.id, true);
  fitCanvas();
});
socket.on('ink:remove', (m) => {
  if (!note || m.noteId !== note.id) return;
  note.strokes = note.strokes.filter(s => !m.strokeIds.includes(s.id));
  markInk(note.id, note.strokes.length > 0);
  redraw();
});

function upsertMeta(meta) {
  const i = notesMeta.findIndex(n => n.id === meta.id);
  const merged = { ...(i >= 0 ? notesMeta[i] : {}), ...meta,
    preview: (meta.body !== undefined ? meta.body : (i >= 0 ? notesMeta[i].preview : '')).slice(0, 120) };
  if (i >= 0) notesMeta[i] = merged; else notesMeta.unshift(merged);
  notesMeta.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
function markInk(id, has) {
  const m = notesMeta.find(n => n.id === id);
  if (m) { m.hasInk = has; renderNotes(); }
}

// ───────────────────────────── markdown ──────────────────────────────────
const renderer = new marked.Renderer();
let codeBlockIndex = 0; // reset on every render; keys per-block font sizes
renderer.code = (text, infostring) => {
  const language = (infostring || '').trim().split(/\s+/)[0];
  let html;
  try {
    html = language && hljs.getLanguage(language)
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value;
  } catch { html = escapeHtml(text); }
  const ci = codeBlockIndex++;
  return `<div class="code-tile" data-ci="${ci}">
    <div class="code-tile-head">
      <span class="code-lang">${escapeHtml(language || 'code')}</span>
      <span class="code-tools">
        <button class="cf-dn" title="Smaller code text">A−</button><span class="cf-val">13</span><button class="cf-up" title="Larger code text">A+</button>
        <button class="c-copy" title="Copy code">Copy</button>
      </span>
    </div>
    <pre class="code-tile-body"><code class="hljs">${html}</code></pre>
  </div>`;
};
marked.setOptions({ renderer, breaks: true, gfm: true });

// Preserve big vertical gaps: normally Markdown collapses any number of blank
// lines into one paragraph break. This block extension turns a run of 2+
// blank lines into a spacer sized to the extra lines, so the paper mirrors
// the editor. Fenced code is untouched (the fence tokenizer owns its region).
marked.use({
  extensions: [{
    name: 'biggap',
    level: 'block',
    start(src) { const m = src.match(/(?:^|\n)(?:[ \t]*\n){2,}/); return m ? m.index : undefined; },
    tokenizer(src) {
      const m = /^(?:[ \t]*\n){3,}/.exec(src);
      if (m) return { type: 'biggap', raw: m[0] };
    },
    renderer(token) {
      const n = (token.raw.match(/\n/g) || []).length;
      return `<div class="md-gap" style="height:${((n - 2) * 1.7).toFixed(1)}em"></div>\n`;
    }
  }]
});
const escapeHtml = (s) => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderMarkdown() {
  if (peSession) return; // an inline paper edit owns the DOM right now
  const raw = note ? (note.body || '') : '';
  codeBlockIndex = 0;
  rendered.innerHTML = DOMPurify.sanitize(marked.parse(raw));
  applyCodeTiles();
  requestAnimationFrame(fitCanvas);
}

// ────── code tiles: font, position, and size — all synced per block ───────
// note.codeTiles = { blockIndex: {font, x, y, w, h} }. Position (x,y) is a
// translate offset from the tile's natural spot in the note flow, so you can
// slide a block aside and hand-write in the freed space — and because it's
// stored with the note, ink and tiles line up the same on every device.

function tileState(ci) {
  note.codeTiles = note.codeTiles || {};
  return (note.codeTiles[ci] = note.codeTiles[ci] || {});
}

function applyCodeTiles() {
  if (!note) return;
  note.codeTiles = note.codeTiles || {};
  for (const tile of rendered.querySelectorAll('.code-tile')) {
    const ci = tile.dataset.ci;
    const st = note.codeTiles[ci] || {};
    const body = tile.querySelector('.code-tile-body');
    const fs = st.font || 13;
    body.style.fontSize = fs + 'px';
    tile.querySelector('.cf-val').textContent = fs;
    if (st.w) body.style.width = st.w + 'px';
    if (st.h) body.style.height = st.h + 'px';
    tile.style.transform = (st.x || st.y)
      ? `translate(${st.x || 0}px, ${st.y || 0}px)` : '';
  }
}

function setCodeFont(ci, delta) {
  const st = tileState(ci);
  st.font = Math.min(26, Math.max(9, (st.font || 13) + delta));
  applyCodeTiles();
  onLocalEdit(); // syncs to the other device + saves
}

rendered.addEventListener('click', async (e) => {
  const tile = e.target.closest('.code-tile');
  if (!tile || !note) return;
  const ci = tile.dataset.ci;
  if (e.target.closest('.cf-up')) setCodeFont(ci, +1);
  else if (e.target.closest('.cf-dn')) setCodeFont(ci, -1);
  else if (e.target.closest('.c-copy')) {
    const code = tile.querySelector('code').innerText;
    try { await navigator.clipboard.writeText(code); } catch {}
    const b = e.target.closest('.c-copy');
    b.textContent = 'Copied ✓';
    setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  }
});

// ---- drag a tile by its header bar (double-click the bar to reset) ----
let drag = null;
rendered.addEventListener('pointerdown', (e) => {
  const head = e.target.closest('.code-tile-head');
  if (!head || e.target.closest('button') || inkMode || !note) return;
  const tile = head.closest('.code-tile');
  const st = tileState(tile.dataset.ci);
  const tr = tile.getBoundingClientRect(), pr = paper.getBoundingClientRect();
  const z = paperZoom || 1; // rects are screen px; tile offsets are page px
  drag = {
    tile, st, z,
    startX: e.clientX, startY: e.clientY,
    baseX: st.x || 0, baseY: st.y || 0,
    // natural (untranslated) bounds in page px, for clamping inside the paper
    natL: (tr.left - pr.left) / z - (st.x || 0),
    natT: (tr.top - pr.top) / z - (st.y || 0),
    w: tr.width / z, h: tr.height / z,
    paperW: pr.width / z, paperH: paper.scrollHeight
  };
  tile.classList.add('dragging');
  head.setPointerCapture(e.pointerId);
  e.preventDefault();
});
rendered.addEventListener('pointermove', (e) => {
  if (!drag) return;
  let nx = drag.baseX + (e.clientX - drag.startX) / drag.z;
  let ny = drag.baseY + (e.clientY - drag.startY) / drag.z;
  nx = Math.min(Math.max(nx, -drag.natL), drag.paperW - drag.natL - drag.w);
  ny = Math.min(Math.max(ny, -drag.natT), drag.paperH - drag.natT - drag.h);
  drag.nx = nx; drag.ny = ny;
  drag.tile.style.transform = `translate(${nx}px, ${ny}px)`;
});
function endTileDrag() {
  if (!drag) return;
  drag.tile.classList.remove('dragging');
  if (drag.nx !== undefined) {
    drag.st.x = Math.round(drag.nx);
    drag.st.y = Math.round(drag.ny);
    onLocalEdit();
  }
  drag = null;
}
rendered.addEventListener('pointerup', endTileDrag);
rendered.addEventListener('pointercancel', endTileDrag);
rendered.addEventListener('dblclick', (e) => {
  const head = e.target.closest('.code-tile-head');
  if (!head || e.target.closest('button') || !note) return;
  const st = tileState(head.closest('.code-tile').dataset.ci);
  st.x = 0; st.y = 0;
  applyCodeTiles();
  onLocalEdit();
});

// remember drag-resizes (native CSS resize corner) so re-renders while typing
// don't snap tiles back; only recorded when the drag starts at the corner.
let resizingBody = null;
rendered.addEventListener('pointerdown', (e) => {
  const body = e.target.closest('.code-tile-body');
  if (!body) return;
  const r = body.getBoundingClientRect();
  const grip = 20 * (paperZoom || 1); // the 20px corner, in screen px
  if (e.clientX > r.right - grip && e.clientY > r.bottom - grip) resizingBody = body;
});
window.addEventListener('pointerup', () => {
  if (!resizingBody || !note) { resizingBody = null; return; }
  const tile = resizingBody.closest('.code-tile');
  if (tile) {
    const st = tileState(tile.dataset.ci);
    st.w = resizingBody.offsetWidth;
    st.h = resizingBody.offsetHeight;
    onLocalEdit();
  }
  resizingBody = null;
  fitCanvas(); // paper height may have changed under the ink layer
});

// ───────────── inline text editing on the paper (canvas pane) ─────────────
// Click any text block on the paper to edit it in place: type, insert words
// mid-line, press Enter for new lines (twice for a new paragraph), and use
// the floating bar for Bold / Italic / A− / A+. Everything you do is written
// straight back into the Markdown source (note.body), so the editor pane and
// the other device stay in step through the existing note:typing/save path.
//
// The block↔source mapping is the same one followCaret/insertBlankPage use:
// each non-'space' lexer token corresponds to one child of #rendered.

let peSession = null; // { el, start, end } or { el, isNew, insertAt, gapLines, spliced }
const ttEl = $('#text-toolbar');
const SIZE_STEPS = [0.75, 0.85, 1, 1.15, 1.35, 1.6, 2];

function blockSourceRange(idx) {
  const body = note ? (note.body || '') : '';
  let off = 0, seen = -1;
  for (const t of marked.lexer(body)) {
    if (t.type !== 'space') {
      seen++;
      if (seen === idx) {
        const trail = (t.raw.match(/\n+$/) || [''])[0]; // keep block separators
        return { start: off, end: off + t.raw.length - trail.length };
      }
    }
    off += t.raw.length;
  }
  return { start: body.length, end: body.length };
}

// ---- DOM block → Markdown ------------------------------------------------
function peInlineNode(ch) {
  if (ch.nodeType === 3) return ch.nodeValue;
  if (ch.nodeType !== 1) return '';
  const tag = ch.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'INPUT') return ch.type === 'checkbox' ? (ch.checked ? '[x] ' : '[ ] ') : '';
  const inner = peInline(ch);
  const wrap = (mark) => {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/); // keep ** tight against text
    return m[2] ? m[1] + mark + m[2] + mark + m[3] : inner;
  };
  if (tag === 'STRONG' || tag === 'B') return wrap('**');
  if (tag === 'EM' || tag === 'I') return wrap('*');
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrap('~~');
  if (tag === 'CODE') return '`' + ch.textContent + '`';
  if (tag === 'A') return '[' + inner + '](' + (ch.getAttribute('href') || '') + ')';
  if (tag === 'U') return '<u>' + inner + '</u>';
  if (tag === 'SPAN') {
    let out = inner;
    if (ch.style && ch.style.fontWeight && /^(bold|[6-9]00)$/.test(ch.style.fontWeight))
      out = out.trim() ? '**' + out + '**' : out;
    if (ch.style && ch.style.fontStyle === 'italic') out = out.trim() ? '*' + out + '*' : out;
    if (ch.style && ch.style.fontSize)
      out = `<span style="font-size:${ch.style.fontSize}">` + out + '</span>';
    return out;
  }
  if (tag === 'DIV' || tag === 'P') return '\n' + peInline(ch); // Enter inside a block
  return inner;
}
function peInline(node) {
  let out = '';
  for (const ch of node.childNodes) out += peInlineNode(ch);
  return out;
}
function peListMd(listEl, indent) {
  const ordered = listEl.tagName === 'OL';
  let i = parseInt(listEl.getAttribute('start') || '1', 10);
  const lines = [];
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? (i++) + '. ' : '- ';
    let text = '';
    const subs = [];
    for (const ch of li.childNodes) {
      if (ch.nodeType === 1 && (ch.tagName === 'UL' || ch.tagName === 'OL')) subs.push(ch);
      else text += peInlineNode(ch);
    }
    lines.push(indent + marker + text.replace(/\n+/g, ' ').trim());
    for (const s of subs) lines.push(peListMd(s, indent + ' '.repeat(marker.length)));
  }
  return lines.join('\n');
}
function domBlockToMd(el) {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag))
    return '#'.repeat(+tag[1]) + ' ' + peInline(el).replace(/\n+/g, ' ').trim();
  if (tag === 'BLOCKQUOTE') {
    const md = el.children.length && [...el.children].every(c => /^(P|UL|OL|H[1-6]|BLOCKQUOTE)$/.test(c.tagName))
      ? [...el.children].map(domBlockToMd).join('\n\n')
      : peInline(el);
    return md.split('\n').map(l => '> ' + l).join('\n');
  }
  if (tag === 'UL' || tag === 'OL') return peListMd(el, '');
  if (tag === 'HR') return '---';
  return peInline(el).replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

// ---- keep the Markdown source in step with the edited block --------------
function peSetBody(b) {
  editor.value = b;
  onLocalEdit(); // streams note:typing + schedules the save; render is guarded
}
function syncPaperEdit() {
  const s = peSession;
  if (!s || !note) return;
  const md = domBlockToMd(s.el);
  const body = note.body || '';
  if (s.isNew && !s.spliced) {
    if (!md.trim()) return; // nothing typed yet — don't dirty the source
    const before = body.slice(0, s.insertAt), after = body.slice(s.insertAt);
    let pre = before ? (before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n') : '';
    pre += '\n'.repeat(s.gapLines || 0); // honor a click far below the text
    const post = after ? (after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n') : '\n';
    s.start = s.insertAt + pre.length;
    s.end = s.start + md.length;
    s.spliced = true;
    peSetBody(before + pre + md + post + after);
  } else if (!s.isNew || s.spliced) {
    peSetBody(body.slice(0, s.start) + md + body.slice(s.end));
    s.end = s.start + md.length;
  }
}

function onPeInput() {
  syncPaperEdit();
  requestAnimationFrame(fitCanvas); // block height changed under the ink layer
}

// ---- session lifecycle ----------------------------------------------------
function placeCaretAt(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
  }
  if (range) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function positionTextToolbar() {
  const s = peSession;
  if (!s) return;
  // the bar is counter-scaled so it stays readable, so its footprint on the
  // page grows as the page shrinks — budget for that when placing it
  const iz = 1 / (paperZoom || 1);
  ttEl.style.top = Math.max(6, s.el.offsetTop - 46 * iz) + 'px';
  ttEl.style.left = Math.min(Math.max(8, s.el.offsetLeft),
                             Math.max(8, paper.clientWidth - 235 * iz)) + 'px';
}

function beginPeSession(el, ev) {
  el.classList.add('pe-active');
  el.setAttribute('contenteditable', 'true');
  el.addEventListener('input', onPeInput);
  try { document.execCommand('styleWithCSS', false, false); } catch {}
  el.focus();
  if (ev && getSelection().isCollapsed) placeCaretAt(ev.clientX, ev.clientY);
  positionTextToolbar();
  ttEl.hidden = false;
}

function startPaperEdit(el, ev) {
  commitPaperEdit();
  const idx = [...rendered.children].indexOf(el);
  if (idx < 0) return;
  const r = blockSourceRange(idx);
  peSession = { el, start: r.start, end: r.end };
  beginPeSession(el, ev);
}

function startPaperInsert(domIndex, insertAt, gapLines) {
  commitPaperEdit();
  const p = document.createElement('p');
  p.className = 'pe-new';
  rendered.insertBefore(p, rendered.children[domIndex] || null);
  peSession = { el: p, isNew: true, insertAt, gapLines: gapLines || 0, spliced: false };
  beginPeSession(p, null);
}

function commitPaperEdit() {
  const s = peSession;
  if (!s) return;
  syncPaperEdit();
  peSession = null;
  s.el.removeEventListener('input', onPeInput);
  s.el.removeAttribute('contenteditable');
  s.el.classList.remove('pe-active');
  if (s.isNew && !s.spliced) s.el.remove(); // empty new paragraph → vanish
  ttEl.hidden = true;
  renderMarkdown(); // normalize what the browser produced while editing
  requestAnimationFrame(fitCanvas);
}
function dropPaperEdit() { // note is switching/deleted: don't serialize into it
  if (!peSession) return;
  peSession.el.removeEventListener('input', onPeInput);
  peSession = null;
  ttEl.hidden = true;
}

// ---- click routing on the paper ------------------------------------------
const PE_EDITABLE = /^(P|H[1-6]|UL|OL|BLOCKQUOTE)$/;

paper.addEventListener('click', (e) => {
  if (inkMode || !note) return;
  if (e.target.closest('#text-toolbar, .page-insert, .code-tile, #page-marks')) return;
  if (e.target.closest('a') && !(peSession && peSession.el.contains(e.target))) return; // let links work
  // which top-level block was clicked (if any)?
  let el = e.target;
  while (el && el !== rendered && el.parentElement !== rendered) el = el.parentElement;
  if (el && el !== rendered && el.parentElement === rendered) {
    if (peSession && peSession.el === el) return;           // already editing it
    if (PE_EDITABLE.test(el.tagName)) { startPaperEdit(el, e); return; }
    if (el.classList.contains('pe-new')) return;
    if (!el.classList.contains('md-gap') && !el.classList.contains('md-page-gap')) return;
  }
  if (peSession) return; // clicking away just commits (handled by pointerdown below)

  // empty area: insert a new paragraph where you clicked
  const y = (e.clientY - paper.getBoundingClientRect().top) / paperZoom; // -> page px
  const kids = [...rendered.children];
  // a click level with an existing block (its margin) edits that block
  const hit = kids.find(k => PE_EDITABLE.test(k.tagName) &&
    y >= k.offsetTop && y <= k.offsetTop + k.offsetHeight);
  if (hit) { startPaperEdit(hit, e); return; }
  let domIndex = kids.findIndex(k => k.offsetTop > y);
  let insertAt, gapLines = 0;
  if (domIndex === -1) {
    domIndex = kids.length;
    insertAt = (note.body || '').length;
    const last = kids[kids.length - 1];
    const below = last ? y - (last.offsetTop + last.offsetHeight) : y;
    if (below > 60) gapLines = Math.min(40, Math.round(below / 26)); // land near the click
  } else {
    insertAt = blockSourceRange(domIndex).start;
  }
  startPaperInsert(domIndex, insertAt, gapLines);
});

// click/tap anywhere outside the block or its toolbar → commit
document.addEventListener('pointerdown', (e) => {
  if (!peSession) return;
  if (peSession.el.contains(e.target) || ttEl.contains(e.target)) return;
  commitPaperEdit();
});

// ---- floating toolbar actions --------------------------------------------
ttEl.addEventListener('pointerdown', (e) => e.preventDefault()); // keep selection/focus

function stepSize(cur, dir) {
  let i = SIZE_STEPS.findIndex(s => Math.abs(s - cur) < 0.03);
  if (i === -1) {
    i = SIZE_STEPS.findIndex(s => s > cur);
    if (i === -1) i = SIZE_STEPS.length - 1;
    else if (dir < 0) i = Math.max(0, i - 1);
    return SIZE_STEPS[i];
  }
  return SIZE_STEPS[Math.min(SIZE_STEPS.length - 1, Math.max(0, i + dir))];
}

function applyFontStep(dir) {
  const s = peSession;
  if (!s) return;
  const sel = getSelection();
  let hasSel = sel && !sel.isCollapsed && s.el.contains(sel.anchorNode);
  if (!hasSel && /^(UL|OL|BLOCKQUOTE)$/.test(s.el.tagName)) {
    // sizing spans must live *inside* the list items, so select the contents
    const r = document.createRange();
    r.selectNodeContents(s.el);
    sel.removeAllRanges();
    sel.addRange(r);
    hasSel = true;
  }
  if (hasSel) {
    // execCommand marks the exact selection with <font size=7>; we swap each
    // marker for a relative-size span (which survives as inline HTML in md).
    document.execCommand('fontSize', false, '7');
    for (const f of s.el.querySelectorAll('font[size="7"]')) {
      let cur = 1;
      const anc = f.parentElement && f.parentElement.closest('span[style*="font-size"]');
      if (anc && s.el.contains(anc)) cur = parseFloat(anc.style.fontSize) || 1;
      const innerSpan = f.querySelector('span[style*="font-size"]');
      if (innerSpan && innerSpan.textContent === f.textContent) {
        cur = parseFloat(innerSpan.style.fontSize) || cur;
        innerSpan.replaceWith(...innerSpan.childNodes);
      }
      const next = stepSize(cur, dir);
      if (Math.abs(next - 1) > 0.03) {
        const span = document.createElement('span');
        span.style.fontSize = next + 'em';
        span.append(...f.childNodes);
        f.replaceWith(span);
      } else {
        f.replaceWith(...f.childNodes);
      }
    }
  } else {
    // no selection → size the whole block
    const first = s.el.firstElementChild;
    const wrapped = first && s.el.childNodes.length === 1 &&
                    first.tagName === 'SPAN' && first.style.fontSize;
    const cur = wrapped ? (parseFloat(first.style.fontSize) || 1) : 1;
    const next = stepSize(cur, dir);
    if (wrapped) {
      if (Math.abs(next - 1) > 0.03) first.style.fontSize = next + 'em';
      else first.replaceWith(...first.childNodes);
    } else if (Math.abs(next - 1) > 0.03) {
      const span = document.createElement('span');
      span.style.fontSize = next + 'em';
      span.append(...s.el.childNodes);
      s.el.appendChild(span);
    }
  }
  s.el.normalize();
  syncPaperEdit();
  positionTextToolbar();
  requestAnimationFrame(fitCanvas);
}

$('#tt-bold').onclick = () => {
  if (!peSession) return;
  document.execCommand('bold', false);
  syncPaperEdit();
  refreshTtState();
};
$('#tt-italic').onclick = () => {
  if (!peSession) return;
  document.execCommand('italic', false);
  syncPaperEdit();
  refreshTtState();
};
$('#tt-bigger').onclick = () => applyFontStep(+1);
$('#tt-smaller').onclick = () => applyFontStep(-1);
$('#tt-done').onclick = () => commitPaperEdit();

function refreshTtState() {
  if (!peSession) return;
  try {
    $('#tt-bold').classList.toggle('on', document.queryCommandState('bold'));
    $('#tt-italic').classList.toggle('on', document.queryCommandState('italic'));
  } catch {}
}
document.addEventListener('selectionchange', () => { if (peSession) refreshTtState(); });

// ───────────────────────────── notebooks ─────────────────────────────────
function renderNotebooks() {
  notebookList.innerHTML = '';
  for (const nb of notebooks) {
    const count = notesMeta.filter(n => n.notebookId === nb.id).length;
    const el = document.createElement('div');
    el.className = 'notebook' + (nb.id === currentNotebookId ? ' on' : '');
    el.innerHTML = `<span>${escapeHtml(nb.title)}</span><span class="count">${count}</span>`;
    el.title = nb.title;
    el.onclick = () => { currentNotebookId = nb.id; renderNotebooks(); renderNotes(); };
    notebookList.appendChild(el);
  }
}

$('#add-notebook').onclick = async () => {
  const title = prompt('Notebook name');
  if (!title) return;
  notebooks.push({ id: 'nb-' + Date.now(), title: title.trim(), created: Date.now() });
  await api('/notebooks', { method: 'PUT', body: JSON.stringify(notebooks) });
  renderNotebooks();
};

// ───────────────────────────── notes list ────────────────────────────────
function visibleNotes() {
  const q = $('#search').value.trim().toLowerCase();
  return notesMeta.filter(n =>
    (!currentNotebookId || n.notebookId === currentNotebookId) &&
    (!q || (n.title || '').toLowerCase().includes(q) || (n.preview || '').toLowerCase().includes(q)));
}

function renderNotes() {
  const list = visibleNotes();
  noteList.innerHTML = '';
  if (!list.length) {
    noteList.innerHTML = `<div class="empty">No notes here yet.<br>Press <b>+ Note</b> to start one.</div>`;
  }
  for (const n of list) {
    const el = document.createElement('div');
    el.className = 'note-card' + (note && n.id === note.id ? ' on' : '');
    el.innerHTML = `
      <div class="t">${n.hasInk ? '<span class="ink-dot">✎</span>' : ''}${escapeHtml(n.title || 'Untitled')}</div>
      <div class="p">${escapeHtml(n.preview || '')}</div>
      <div class="d">${new Date(n.updated || n.created).toLocaleString()}</div>`;
    el.onclick = () => openNote(n.id);
    noteList.appendChild(el);
  }
  renderNotebooks();
}

$('#search').addEventListener('input', renderNotes);

const nnOverlay = $('#newnote-overlay');
$('#add-note').onclick = () => { nnOverlay.hidden = false; };
$('#newnote-cancel').onclick = () => { nnOverlay.hidden = true; };
nnOverlay.addEventListener('click', (e) => { if (e.target === nnOverlay) nnOverlay.hidden = true; });

async function createNote(pageMode) {
  nnOverlay.hidden = true;
  const id = 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const nb = currentNotebookId || (notebooks[0] && notebooks[0].id);
  const fresh = { id, notebookId: nb, title: '', body: '', strokes: [], codeTiles: {},
                  pageMode, created: Date.now(), updated: Date.now() };
  await api('/notes/' + id, { method: 'PUT', body: JSON.stringify(fresh) });
  upsertMeta({ ...fresh, preview: '' });
  note = fresh;
  showNote(note);
  closeDrawer();
  titleEl.focus();
}
$('#choose-a4').onclick = () => createNote('a4');
$('#choose-infinite').onclick = () => createNote('infinite');

async function openNote(id) {
  closeDrawer();
  if (note && note.id === id) return;
  commitPaperEdit();
  flushSave();
  const n = await api('/notes/' + id);
  if (!n) return;
  n.strokes = Array.isArray(n.strokes) ? n.strokes : [];
  n.codeTiles = n.codeTiles && typeof n.codeTiles === 'object' ? n.codeTiles : {};
  if (n.pageMode !== 'infinite') n.pageMode = 'a4';
  if (n.codeSizes && typeof n.codeSizes === 'object') {   // migrate old format
    for (const [ci, f] of Object.entries(n.codeSizes))
      n.codeTiles[ci] = { font: f, ...(n.codeTiles[ci] || {}) };
    delete n.codeSizes;
  }
  note = n;
  undoStack = []; redoStack = []; liveRemote.clear();
  showNote(n);
}

function pageModeLabel() {
  $('#btn-pagemode').textContent = (note && note.pageMode === 'infinite') ? '∞ Scroll' : '📄 A4';
}
$('#btn-pagemode').onclick = () => {
  if (!note) return;
  note.pageMode = note.pageMode === 'infinite' ? 'a4' : 'infinite';
  note.updated = Date.now();
  pageModeLabel();
  fitCanvas();
  flushSave();
  socket.emit('note:reload', { id: note.id });
};

function showNote(n) {
  dropPaperEdit(); // any leftover session belongs to a previous note
  setInkMode(false);
  titleEl.value = n ? (n.title || '') : '';
  editor.value = n ? (n.body || '') : '';
  pageModeLabel();
  renderMarkdown();
  renderNotes();
  redraw();
}

$('#btn-delete').onclick = async () => {
  if (!note) return;
  if (!confirm(`Delete “${note.title || 'Untitled'}”? This removes it on every device.`)) return;
  const id = note.id;
  note = null;
  await api('/notes/' + id, { method: 'DELETE' });
  notesMeta = notesMeta.filter(n => n.id !== id);
  showNote(null);
};

$('#btn-export').onclick = () => {
  if (!note) return;
  const blob = new Blob([note.body || ''], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ((note.title || 'note').replace(/[^\w\- ]+/g, '').trim() || 'note') + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
};

// PDF export: the print stylesheet strips the app chrome, maps each on-screen
// A4 page onto one real A4 sheet (ink included), and the browser's print
// dialog does the rest — pick "Save as PDF".
$('#btn-pdf').onclick = () => {
  if (!note) return;
  commitPaperEdit();
  const wasInk = inkMode;
  setInkMode(false);
  const prev = document.title;
  document.title = (note.title || 'note').replace(/[^\w\- ]+/g, '').trim() || 'note';
  window.print();
  document.title = prev;
  if (wasInk) setInkMode(true);
};

$('#logout').onclick = async () => {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login';
};

// ───────────────────────────── text editing + sync ───────────────────────
function onLocalEdit() {
  if (!note) return;
  lastLocalInput = Date.now();
  if (document.activeElement === editor) scheduleCaretFollow();
  note.title = titleEl.value;
  note.body = editor.value;
  note.updated = Date.now();
  renderMarkdown();
  upsertMeta({ id: note.id, notebookId: note.notebookId, title: note.title,
               body: note.body, updated: note.updated, created: note.created });
  renderNotes();

  // fast path: stream keystrokes to the other device (throttled)
  if (!typingTimer) {
    typingTimer = setTimeout(() => {
      typingTimer = null;
      if (note) socket.emit('note:typing', {
        id: note.id, notebookId: note.notebookId,
        title: note.title, body: note.body, codeTiles: note.codeTiles,
        updated: note.updated, created: note.created
      });
    }, 150);
  }
  // durable path: debounced save to disk
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!note) return;
  api('/notes/' + note.id, { method: 'PUT', body: JSON.stringify(note) }).catch(() => {});
}

titleEl.addEventListener('input', onLocalEdit);
editor.addEventListener('input', onLocalEdit);
window.addEventListener('beforeunload', flushSave);

// ───────────────────────────── code block dialog ─────────────────────────
const overlay = $('#code-overlay'), langSel = $('#code-lang'), codeText = $('#code-text');
for (const [val, label] of LANGUAGES) {
  const o = document.createElement('option');
  o.value = val; o.textContent = label;
  langSel.appendChild(o);
}

function openCodeDialog() {
  if (!note) return;
  overlay.hidden = false;
  codeText.value = '';
  codeText.focus();
}
function closeCodeDialog() { overlay.hidden = true; editor.focus(); }

$('#btn-code').onclick = openCodeDialog;
$('#code-cancel').onclick = closeCodeDialog;
$('#code-cancel-x').onclick = closeCodeDialog;
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCodeDialog(); });

$('#code-insert').onclick = () => {
  const lang = langSel.value;
  let code = codeText.value.replace(/\s+$/, '');
  if (!code) { closeCodeDialog(); return; }
  const fence = '```';
  const block = `\n${fence}${lang}\n${code}\n${fence}\n`;
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? start;
  editor.value = editor.value.slice(0, start) + block + editor.value.slice(end);
  editor.selectionStart = editor.selectionEnd = start + block.length;
  onLocalEdit();
  closeCodeDialog();
};

// ─────────── VS Code-style editing inside the code dialog ────────────────
// Enter keeps the current indent and deepens it after openers (`{`, `(`, `[`,
// `:` in Python, opening tags in HTML). Tab/Shift+Tab indent/dedent, including
// multi-line selections. Brackets and quotes auto-pair, wrap selections, and
// closers skip over / smart-dedent — with per-language indent width.

const TWO_SPACE = new Set(['html','css','scss','json','yaml','xml','ruby','dart','markdown']);
const indentUnit = () => ' '.repeat(TWO_SPACE.has(langSel.value) ? 2 : 4);
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

langSel.addEventListener('change', () => codeText.focus());

// insert via execCommand so the browser's native undo stack keeps working
function edInsert(text) {
  codeText.focus();
  if (!document.execCommand('insertText', false, text)) {
    const s = codeText.selectionStart, e = codeText.selectionEnd;
    codeText.setRangeText(text, s, e, 'end');
  }
}
function edReplaceRange(start, end, text) {
  codeText.setSelectionRange(start, end);
  edInsert(text);
}

function lineStartAt(v, pos) { return v.lastIndexOf('\n', pos - 1) + 1; }
function leadingWS(line) { return (line.match(/^[ \t]*/) || [''])[0]; }

function opensBlock(line) {
  const t = line.trimEnd();
  if (!t) return false;
  const lang = langSel.value;
  if (lang === 'python' && /[:([{]$/.test(t)) return true;
  if (/[([{]$/.test(t)) return true;
  if ((lang === 'html' || lang === 'xml') &&
      /<([a-zA-Z][\w-]*)(\s[^<>]*)?>$/.test(t) &&
      !/<\/|\/>$/.test(t.slice(-2)) &&
      !/^<(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)\b/i
        .test(t.match(/<([a-zA-Z][\w-]*)[^<>]*>$/)[0])) return true;
  if (lang === 'bash' && /\b(then|do|else|elif .*|\{)$/.test(t)) return true;
  return false;
}

codeText.addEventListener('keydown', (e) => {
  const v = codeText.value;
  const s = codeText.selectionStart, en = codeText.selectionEnd;
  const unit = indentUnit();

  // ---- Tab / Shift+Tab ----
  if (e.key === 'Tab') {
    e.preventDefault();
    const selText = v.slice(s, en);
    if (selText.includes('\n') || (e.shiftKey && s !== en)) {
      // block indent / dedent across all touched lines
      const from = lineStartAt(v, s);
      let to = v.indexOf('\n', en - (en > s && v[en - 1] === '\n' ? 1 : 0));
      if (to === -1) to = v.length;
      const lines = v.slice(from, to).split('\n');
      const out = lines.map(l => e.shiftKey
        ? l.replace(new RegExp('^(\\t|' + ' '.repeat(unit.length) + '| {1,' + (unit.length - 1) + '})'), '')
        : (l.length ? unit + l : l)).join('\n');
      edReplaceRange(from, to, out);
      codeText.setSelectionRange(from, from + out.length);
    } else if (e.shiftKey) {
      // dedent the current line, keep the caret in place
      const from = lineStartAt(v, s);
      const ws = leadingWS(v.slice(from));
      const cut = ws ? (ws.endsWith('\t') ? 1 : Math.min(unit.length, ws.length)) : 0;
      if (cut) {
        edReplaceRange(from + ws.length - cut, from + ws.length, '');
        codeText.setSelectionRange(Math.max(from, s - cut), Math.max(from, s - cut));
      }
    } else {
      edInsert(unit);
    }
    return;
  }

  // ---- Enter: keep indent, deepen after openers, expand between brackets ----
  if (e.key === 'Enter') {
    e.preventDefault();
    const from = lineStartAt(v, s);
    const base = leadingWS(v.slice(from, s));
    const prev = v[s - 1], next = v[en];
    if (prev && CLOSERS[next] === prev) {
      // caret between {} / () / [] → open the block VS Code-style
      edInsert('\n' + base + unit + '\n' + base);
      const caret = s + 1 + base.length + unit.length;
      codeText.setSelectionRange(caret, caret);
    } else {
      const deeper = opensBlock(v.slice(from, s));
      edInsert('\n' + base + (deeper ? unit : ''));
    }
    codeText.blur(); codeText.focus(); // keep caret scrolled into view
    return;
  }

  // ---- closers: skip over auto-closed char, smart-dedent on blank line ----
  if (CLOSERS[e.key] && s === en) {
    if (v[s] === e.key) { e.preventDefault(); codeText.setSelectionRange(s + 1, s + 1); return; }
    const from = lineStartAt(v, s);
    const before = v.slice(from, s);
    if (/^[ \t]+$/.test(before) && before.length >= unit.length) {
      e.preventDefault();
      edReplaceRange(from + before.length - unit.length, s, e.key);
      return;
    }
    return; // plain insert
  }

  // ---- openers & quotes: wrap selection or auto-pair ----
  if (PAIRS[e.key]) {
    const close = PAIRS[e.key];
    if (s !== en) {                       // wrap the selection
      e.preventDefault();
      const sel = v.slice(s, en);
      edInsert(e.key + sel + close);
      codeText.setSelectionRange(s + 1, s + 1 + sel.length);
      return;
    }
    const isQuote = e.key === close;
    const nextCh = v[s] || '';
    const prevCh = v[s - 1] || '';
    const okHere = isQuote
      ? (!/[\w"'`]/.test(prevCh) && (nextCh === '' || /[\s)\]},;:]/.test(nextCh)))
      : (nextCh === '' || /[\s)\]},;:]/.test(nextCh));
    if (okHere) {
      e.preventDefault();
      edInsert(e.key + close);
      codeText.setSelectionRange(s + 1, s + 1);
    }
    return;
  }

  // ---- backspace inside an empty pair removes both ----
  if (e.key === 'Backspace' && s === en && s > 0) {
    const pair = v[s - 1] + (v[s] || '');
    if (PAIRS[v[s - 1]] === v[s] && ['()', '[]', '{}', '""', "''", '``'].includes(pair)) {
      e.preventDefault();
      edReplaceRange(s - 1, s + 1, '');
    }
  }
});

// ───────────────────────────── ink engine ────────────────────────────────
function setInkMode(on) {
  if (on) commitPaperEdit();
  inkMode = on && !!note;
  paper.classList.toggle('inking', inkMode);
  penTray.hidden = !inkMode;
  if (typeof closePenPop === 'function' && !inkMode) closePenPop();
  $('#btn-ink').classList.toggle('on', inkMode);
  if (inkMode) {
    const p = $('#panes');
    if (p.classList.contains('writing')) {
      p.classList.remove('writing');
      $('#btn-view').textContent = '¶ Write';
    }
    requestAnimationFrame(fitCanvas);
  }
}
$('#btn-ink').onclick = () => setInkMode(!inkMode);

// narrow screens open straight onto the paper; ☰ slides the panels in
const appEl = document.querySelector('.app');
const closeDrawer = () => appEl.classList.remove('drawer-open');
$('#btn-drawer').onclick = () => appEl.classList.toggle('drawer-open');
$('#drawer-backdrop').onclick = closeDrawer;

// narrow screens (tablet/phone) show one pane at a time
const panes = $('#panes'), btnView = $('#btn-view');
btnView.onclick = () => {
  commitPaperEdit();
  const writing = panes.classList.toggle('writing');
  btnView.textContent = writing ? '⬒ Page' : '¶ Write';
  if (writing) setInkMode(false); else requestAnimationFrame(fitCanvas);
};

// ───────── OneNote-style pen gallery: presets + thickness/color popup ─────
// Click a pen to pick it up; click the selected pen again for its Thickness
// and Ink Colors dropdown. Customizations stick to that pen (per browser).

const DEFAULT_PENS = [
  { id: 'pen-black',  kind: 'pen', color: '#111318', size: 3 },
  { id: 'pen-blue',   kind: 'pen', color: '#1D3A6E', size: 3 },
  { id: 'pen-red',    kind: 'pen', color: '#B3232A', size: 3 },
  { id: 'pen-green',  kind: 'pen', color: '#1C7A3D', size: 3 },
  { id: 'hl-yellow',  kind: 'hl',  color: '#FFE01A', size: 4 },
  { id: 'hl-green',   kind: 'hl',  color: '#8CE04A', size: 4 },
  { id: 'hl-pink',    kind: 'hl',  color: '#FF7EC9', size: 4 }
];
const THICKNESSES = [1, 2, 3, 5, 8];
const INK_COLORS = [
  '#111318', '#5B6069', '#8B93A1', '#7A4B12',
  '#B3232A', '#E2452D', '#D2691E', '#E8B31A',
  '#FFE01A', '#8CE04A', '#1C7A3D', '#0F7E7E',
  '#2F6FDE', '#1D3A6E', '#6B3FA0', '#D4498E'
];

let pens;
try { pens = JSON.parse(localStorage.getItem('inkwell-pens')) || null; } catch { pens = null; }
if (!Array.isArray(pens) || pens.length !== DEFAULT_PENS.length) pens = DEFAULT_PENS.map(p => ({ ...p }));
let activePenId = pens[0].id;
const savePens = () => { try { localStorage.setItem('inkwell-pens', JSON.stringify(pens)); } catch {} };

const penGallery = $('#pen-gallery'), penPop = $('#pen-pop');
const eraserBtn = $('#tool-eraser');

// OneNote-style glyphs: vertical pen (conical tip) and chisel highlighter
function penSVG(color) {
  return `<svg viewBox="0 0 24 48" width="24" height="48">
    <rect x="7.5" y="3" width="9" height="24" rx="3.2" fill="${color}" stroke="#4A5160" stroke-width="1"/>
    <path d="M8 26.2 L12 40 L16 26.2 Z" fill="${color}" stroke="#4A5160" stroke-width="1" stroke-linejoin="round"/>
    <path d="M11 36.6 L12 40 L13 36.6 Z" fill="#14161B"/>
    <rect x="7.5" y="6.5" width="9" height="3" fill="rgba(255,255,255,.28)"/>
  </svg>`;
}
function hlSVG(color) {
  return `<svg viewBox="0 0 26 48" width="26" height="48">
    <rect x="5.5" y="3" width="15" height="23" rx="2.6" fill="${color}" stroke="#4A5160" stroke-width="1"/>
    <path d="M7 26 h12 l-2.6 11 h-6.8 Z" fill="${color}" stroke="#4A5160" stroke-width="1" stroke-linejoin="round"/>
    <rect x="8.4" y="35.5" width="9.2" height="2.4" fill="#14161B" opacity=".8"/>
    <rect x="5.5" y="6" width="15" height="3" fill="rgba(255,255,255,.3)"/>
  </svg>`;
}

function renderPenGallery() {
  penGallery.innerHTML = '';
  for (const pn of pens) {
    const b = document.createElement('button');
    b.className = 'pen-item' + (tool !== 'eraser' && pn.id === activePenId ? ' on' : '');
    b.dataset.pen = pn.id;
    b.title = (pn.kind === 'hl' ? 'Highlighter' : 'Pen') + ' — click again for thickness & color';
    b.innerHTML = pn.kind === 'hl' ? hlSVG(pn.color) : penSVG(pn.color);
    penGallery.appendChild(b);
  }
  eraserBtn.classList.toggle('on', tool === 'eraser');
}

function applyPen(pn) {
  tool = pn.kind === 'hl' ? 'highlighter' : 'pen';
  color = pn.color;
  size = pn.size;
  activePenId = pn.id;
  renderPenGallery();
}

function openPenPop(anchorBtn, pn) {
  // Thickness row
  const thick = $('#thick-row');
  thick.innerHTML = '';
  for (const t of THICKNESSES) {
    const b = document.createElement('button');
    b.className = 'thick-btn' + (pn.size === t ? ' on' : '');
    const d = 3 + t * 1.6;
    b.innerHTML = `<i style="width:${d}px;height:${d}px"></i>`;
    b.title = t + ' px';
    b.onclick = () => { pn.size = t; savePens(); applyPen(pn); openPenPop(anchorBtn, pn); };
    thick.appendChild(b);
  }
  // Ink colors grid
  const grid = $('#color-grid');
  grid.innerHTML = '';
  for (const c of INK_COLORS) {
    const b = document.createElement('button');
    b.className = 'ink-swatch' + (pn.color.toLowerCase() === c.toLowerCase() ? ' on' : '');
    b.style.setProperty('--c', c);
    b.title = c;
    b.onclick = () => { pn.color = c; savePens(); applyPen(pn); closePenPop(); };
    grid.appendChild(b);
  }
  // position under the pen, inside the work column
  penPop.hidden = false;
  const work = document.querySelector('.work');
  const wr = work.getBoundingClientRect(), br = anchorBtn.getBoundingClientRect();
  const left = Math.min(Math.max(8, br.left - wr.left - 100), wr.width - 250);
  penPop.style.left = left + 'px';
  penPop.style.top = (br.bottom - wr.top + 6) + 'px';
}
function closePenPop() { penPop.hidden = true; }

penGallery.addEventListener('click', (e) => {
  const b = e.target.closest('.pen-item');
  if (!b) return;
  const pn = pens.find(p => p.id === b.dataset.pen);
  if (!pn) return;
  const wasActive = tool !== 'eraser' && pn.id === activePenId;
  applyPen(pn);
  if (wasActive) {
    penPop.hidden ? openPenPop(penGallery.querySelector('.pen-item.on'), pn) : closePenPop();
  } else {
    closePenPop();
  }
});

eraserBtn.addEventListener('click', () => {
  tool = 'eraser';
  closePenPop();
  renderPenGallery();
});

document.addEventListener('pointerdown', (e) => {
  if (!penPop.hidden && !e.target.closest('#pen-pop') && !e.target.closest('.pen-item')) closePenPop();
});

$('#palm').onclick = () => {
  palmReject = !palmReject;
  $('#palm').classList.toggle('on', palmReject);
};

// pick up the default pen
applyPen(pens.find(p => p.id === activePenId) || pens[0]);

// canvas sizing.
// The page is ALWAYS PAPER_W wide in its own coordinates — on a phone we shrink
// the whole page with a CSS transform instead of letting it reflow narrower.
// That keeps ONE coordinate system across devices: text, code tiles, page
// breaks and ink strokes all land on the same spot no matter the display size.
// paperZoom is only the screen scale (screen px per page px), never part of a
// stored coordinate.
// Per-note page style (note.pageMode):
//   'a4'       — Word-style stack of A4 pages: height snaps to whole pages,
//                a new page is added automatically as text or ink nears the
//                end, and every boundary offers "insert blank page".
//   'infinite' — one endless sheet that grows with the content.
let paperZoom = 1, dpr = 1;
const A4_RATIO = 297 / 210;
const PAGE_H_LOGICAL = Math.round(PAPER_W * A4_RATIO); // 1160 in stroke space

function maxInkY() {
  let m = 0;
  if (note && Array.isArray(note.strokes))
    for (const s of note.strokes)
      for (const p of s.points) if (p.y > m) m = p.y;
  return m; // page px — same units as the rest of the page
}

function updatePageMarks(pages, pageH) {
  let marks = document.getElementById('page-marks');
  if (!marks) {
    marks = document.createElement('div');
    marks.id = 'page-marks';
    paper.insertBefore(marks, canvas);
  }
  const want = 'p' + pages + 'h' + pageH;
  if (marks.dataset.sig === want) return;
  marks.dataset.sig = want;
  marks.innerHTML = '';
  for (let i = 1; i < pages; i++) {
    const sep = document.createElement('div');
    sep.className = 'page-sep';
    sep.style.top = (i * pageH) + 'px';
    sep.dataset.label = 'A4 · page ' + (i + 1);
    const add = document.createElement('button');
    add.className = 'page-insert';
    add.textContent = '＋ blank page';
    add.title = 'Insert a blank page between page ' + i + ' and ' + (i + 1);
    add.dataset.page = i;
    sep.appendChild(add);
    marks.appendChild(sep);
  }
}

function fitCanvas() {
  const avail = paperFit.clientWidth;
  if (!avail) return;
  dpr = window.devicePixelRatio || 1;
  paperZoom = Math.min(1, avail / PAPER_W); // shrink to fit; never blow up past 1:1
  paper.style.setProperty('--zoom', paperZoom);
  paper.style.setProperty('--inv-zoom', 1 / paperZoom);
  const pageH = PAGE_H_LOGICAL; // a page is a page — identical on every device
  paper.style.setProperty('--page-h', pageH + 'px');
  const contentH = Math.max(rendered.scrollHeight + 48, maxInkY() + 80);
  let h;
  if (note && note.pageMode === 'infinite') {
    // always leave a stretch of blank paper past the text for handwriting
    h = Math.max(contentH, 600) + 360;
    updatePageMarks(1, pageH); // clears separators
  } else {
    let pages = Math.max(1, Math.ceil(contentH / pageH));
    // keep at least ~a fifth of a page free at the end so there's room to ink
    if (pages * pageH - contentH < pageH * 0.2) pages++;
    h = pages * pageH;
    updatePageMarks(pages, pageH);
  }
  if (paper.style.height !== h + 'px') paper.style.height = h + 'px';
  // a transform doesn't resize the layout box, so give the scroller the
  // on-screen size of the scaled page
  paperFit.style.height = Math.round(h * paperZoom) + 'px';
  canvas.style.height = h + 'px';
  // backing store follows the *screen* size so ink stays crisp when zoomed out
  canvas.width = Math.round(PAPER_W * paperZoom * dpr);
  canvas.height = Math.round(h * paperZoom * dpr);
  redraw();
}
new ResizeObserver(fitCanvas).observe(paperScroll);

// ── insert a blank page at a boundary: text below shifts one page via a
// full-page spacer spliced into the markdown; ink below shifts one page in
// stroke space; other devices refetch the note.
function insertBlankPage(pageIndex) {
  if (!note) return;
  commitPaperEdit();
  const boundary = pageIndex * PAGE_H_LOGICAL; // page px == stroke units

  // map the boundary to a position in the markdown source: find the first
  // rendered block that starts below it, then splice before its source token
  const kids = [...rendered.children];
  let target = kids.findIndex(k => k.offsetTop >= boundary);
  const tokens = marked.lexer(note.body || '').filter(t => t.type !== 'space');
  let offset = (note.body || '').length; // default: append at the end
  if (target !== -1 && target < tokens.length) {
    offset = 0;
    const all = marked.lexer(note.body || '');
    let seen = 0;
    for (const t of all) {
      if (t.type !== 'space' && seen === target) break;
      offset += t.raw.length;
      if (t.type !== 'space') seen++;
    }
  }
  const spacer = '\n\n<div class="md-page-gap"></div>\n\n';
  note.body = (note.body || '').slice(0, offset) + spacer + (note.body || '').slice(offset);

  // shift ink at/below the boundary down one page
  for (const s of note.strokes || [])
    if (s.points.length && Math.min(...s.points.map(p => p.y)) >= boundary)
      for (const p of s.points) p.y += PAGE_H_LOGICAL;

  note.updated = Date.now();
  editor.value = note.body;
  renderMarkdown();
  flushSave();
  socket.emit('note:reload', { id: note.id });
}

paperScroll.addEventListener('click', (e) => {
  const b = e.target.closest('.page-insert');
  if (b) insertBlankPage(+b.dataset.page);
});

// ─────────── independent scrolling + typing-follows-caret ────────────────
// The two panes scroll freely on their own. But while you TYPE, the paper
// auto-scrolls to the block where the caret is inserting, so you always see
// what you're writing. A dead-zone stops it from twitching on every key.
let followTimer = null;
function scheduleCaretFollow() {
  clearTimeout(followTimer);
  followTimer = setTimeout(followCaret, 180);
}

function followCaret() {
  if (!note || document.activeElement !== editor) return;
  const body = note.body || '';
  const pos = editor.selectionStart ?? body.length;

  // map the caret's character offset to the rendered block via the same
  // token↔child correspondence used for blank-page insertion
  let off = 0, nonSpace = -1, target = 0;
  for (const t of marked.lexer(body)) {
    const isBlock = t.type !== 'space';
    if (isBlock) nonSpace++;
    if (pos <= off + t.raw.length) { target = isBlock ? nonSpace : nonSpace + 1; break; }
    off += t.raw.length;
    target = nonSpace + 1;
  }
  const kids = rendered.children;
  if (!kids.length) return;
  const el = kids[Math.max(0, Math.min(target, kids.length - 1))];

  const sr = paperScroll.getBoundingClientRect();
  const rel = el.getBoundingClientRect().top - sr.top;
  const H = paperScroll.clientHeight;
  if (rel > H * 0.12 && rel < H * 0.72) return; // already comfortably visible
  const top = rel + paperScroll.scrollTop - H * 0.3;
  paperScroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

// screen px -> page px: read the live scale off the canvas rect so this holds
// whatever the device size or zoom is
function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  const k = r.width ? PAPER_W / r.width : 1;
  return {
    x: (e.clientX - r.left) * k,
    y: (e.clientY - r.top) * k,
    p: e.pressure && e.pressure > 0 ? e.pressure : 0.5
  };
}

function drawStroke(s) {
  const pts = s.points;
  if (!pts || pts.length === 0) return;
  ctx.save();
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size * 3.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {          // curve through midpoints
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const L = pts[pts.length - 1];
    ctx.lineTo(L.x, L.y);
    ctx.stroke();
  } else {
    drawPenOutline(s);
  }
  ctx.restore();
}

// Pen strokes render as a single filled outline whose width follows pressure,
// with quadratic curves through edge midpoints — no visible segment joints.
function drawPenOutline(s) {
  const pts = s.points;
  const radius = (p) => Math.max(0.35, s.size * (0.45 + p.p * 1.4)) / 2;
  ctx.fillStyle = s.color;

  if (pts.length < 3) {
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius(p), 0, Math.PI * 2);
      ctx.fill();
    }
    if (pts.length === 2) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = radius(pts[0]) + radius(pts[1]);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
    }
    return;
  }

  // left/right edge points from per-point normals
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = radius(pts[i]);
    L.push({ x: pts[i].x - dy * r, y: pts[i].y + dx * r });
    R.push({ x: pts[i].x + dy * r, y: pts[i].y - dx * r });
  }

  const curveThrough = (arr, reverse) => {
    const a = reverse ? [...arr].reverse() : arr;
    ctx.lineTo(a[0].x, a[0].y);
    for (let i = 1; i < a.length - 1; i++) {
      const mx = (a[i].x + a[i + 1].x) / 2, my = (a[i].y + a[i + 1].y) / 2;
      ctx.quadraticCurveTo(a[i].x, a[i].y, mx, my);
    }
    ctx.lineTo(a[a.length - 1].x, a[a.length - 1].y);
  };

  ctx.beginPath();
  ctx.moveTo(L[0].x, L[0].y);
  curveThrough(L, false);
  curveThrough(R, true);
  ctx.closePath();
  ctx.fill();

  // round caps
  for (const i of [0, pts.length - 1]) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, radius(pts[i]), 0, Math.PI * 2);
    ctx.fill();
  }
}

function redraw() {
  ctx.setTransform(dpr * paperZoom, 0, 0, dpr * paperZoom, 0, 0);
  ctx.clearRect(0, 0, PAPER_W, canvas.height / (dpr * paperZoom));
  if (!note) return;
  for (const s of note.strokes) drawStroke(s);
  for (const s of liveRemote.values()) drawStroke(s);
  if (activeStroke) drawStroke(activeStroke);
}

// drawing state
let activeStroke = null, pendingPoints = [], pointsTimer = null, erasedIds = new Set();

// input smoothing: exponential moving average kills sensor jitter; a minimum
// travel distance drops duplicate/noisy samples. Smoothed points are what get
// stored and synced, so the stroke is identical butter everywhere.
let ema = null;
function smoothPoint(raw) {
  if (!ema) { ema = { ...raw }; return { ...raw }; }
  ema.x += (raw.x - ema.x) * 0.45;
  ema.y += (raw.y - ema.y) * 0.45;
  ema.p += (raw.p - ema.p) * 0.3;
  return { x: +ema.x.toFixed(2), y: +ema.y.toFixed(2), p: +ema.p.toFixed(3) };
}
function addSmoothed(raw) {
  const pt = smoothPoint(raw);
  const last = activeStroke.points[activeStroke.points.length - 1];
  if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.8) return; // jitter gate
  activeStroke.points.push(pt);
  pendingPoints.push(pt);
}

function flushPoints() {
  pointsTimer = null;
  if (!activeStroke || pendingPoints.length === 0) return;
  socket.emit('ink:points', { noteId: note.id, strokeId: activeStroke.id, points: pendingPoints });
  pendingPoints = [];
}

// In ink mode a palm-rejected finger shouldn't be dead — it pans the page,
// like OneNote: finger scrolls, pen draws.
let touchPan = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!inkMode || !note) return;
  if (palmReject && e.pointerType === 'touch') {
    touchPan = { id: e.pointerId, y: e.clientY, top: paperScroll.scrollTop };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    return;
  }
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch {}

  if (tool === 'eraser') { erasedIds = new Set(); eraseAt(toLogical(e)); return; }

  ema = null;
  activeStroke = {
    id: 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    tool, color, size, points: []
  };
  pendingPoints = [];
  addSmoothed(toLogical(e));
  socket.emit('ink:begin', { noteId: note.id, stroke: { ...activeStroke, points: [] } });
  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!inkMode || !note) return;
  if (touchPan && e.pointerId === touchPan.id) {
    paperScroll.scrollTop = touchPan.top - (e.clientY - touchPan.y);
    return;
  }
  if (palmReject && e.pointerType === 'touch') return;
  if (tool === 'eraser') {
    if (e.buttons) eraseAt(toLogical(e));
    return;
  }
  if (!activeStroke) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ce of events) addSmoothed(toLogical(ce));
  pressureOut.textContent = 'pressure ' + (e.pressure || 0.5).toFixed(2);
  if (!pointsTimer) pointsTimer = setTimeout(flushPoints, 40); // ~25 fps to the other device
  // in A4 mode, add the next page before the pen hits the bottom edge
  const lastPt = activeStroke.points[activeStroke.points.length - 1];
  if (lastPt && note.pageMode !== 'infinite' &&
      lastPt.y > canvas.clientHeight - 60) fitCanvas();
  redraw();
});

function endStroke(e) {
  if (touchPan && e && e.pointerId === touchPan.id) { touchPan = null; return; }
  if (tool === 'eraser') { finishErase(); return; }
  if (!activeStroke) return;
  flushPoints();
  const s = activeStroke;
  activeStroke = null;
  note.strokes.push(s);
  undoStack.push({ type: 'add', strokes: [s] });
  redoStack = [];
  socket.emit('ink:end', { noteId: note.id, stroke: s });
  note.updated = Date.now();
  markInk(note.id, true);
  pressureOut.textContent = 'pressure —';
  fitCanvas();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// eraser: remove whole strokes near the pointer, keeping copies for undo
let removedStrokesCache = [];
function eraseAt(pt) {
  const hitR = 8;
  const hit = note.strokes.filter(s => !erasedIds.has(s.id) && strokeNear(s, pt, hitR));
  if (!hit.length) return;
  for (const s of hit) { erasedIds.add(s.id); removedStrokesCache.push(s); }
  note.strokes = note.strokes.filter(s => !erasedIds.has(s.id));
  redraw();
}
function finishErase() {
  if (!erasedIds.size) return;
  undoStack.push({ type: 'remove', strokes: [...removedStrokesCache] });
  redoStack = [];
  socket.emit('ink:remove', { noteId: note.id, strokeIds: [...erasedIds] });
  note.updated = Date.now();
  markInk(note.id, note.strokes.length > 0);
  erasedIds = new Set();
  removedStrokesCache = [];
}

function strokeNear(s, pt, r) {
  const pts = s.points;
  const rr = r + (s.tool === 'highlighter' ? s.size * 1.8 : s.size);
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - pt.x, dy = pts[i].y - pt.y;
    if (dx * dx + dy * dy < rr * rr) return true;
  }
  return false;
}

// undo / redo (synced: undo emits remove, redo re-adds via ink:end)
function inkUndo() {
  const op = undoStack.pop();
  if (!op) return;
  if (op.type === 'add') {
    const ids = op.strokes.map(s => s.id);
    note.strokes = note.strokes.filter(s => !ids.includes(s.id));
    socket.emit('ink:remove', { noteId: note.id, strokeIds: ids });
  } else {
    note.strokes.push(...op.strokes);
    for (const s of op.strokes) socket.emit('ink:end', { noteId: note.id, stroke: s });
  }
  redoStack.push(op);
  markInk(note.id, note.strokes.length > 0);
  redraw();
}
function inkRedo() {
  const op = redoStack.pop();
  if (!op) return;
  if (op.type === 'add') {
    note.strokes.push(...op.strokes);
    for (const s of op.strokes) socket.emit('ink:end', { noteId: note.id, stroke: s });
  } else {
    const ids = op.strokes.map(s => s.id);
    note.strokes = note.strokes.filter(s => !ids.includes(s.id));
    socket.emit('ink:remove', { noteId: note.id, strokeIds: ids });
  }
  undoStack.push(op);
  markInk(note.id, note.strokes.length > 0);
  redraw();
}
$('#ink-undo').onclick = inkUndo;
$('#ink-redo').onclick = inkRedo;

// ─────────── resizable partitions: rail | notes | editor/paper ────────────
// Drag the thin handle on each divider; widths persist in this browser.
const LAYOUT_KEY = 'inkwell-layout';
const rootStyle = document.documentElement.style;

function applyLayout(l) {
  if (l.rail)  rootStyle.setProperty('--rail-w',  l.rail  + 'px');
  if (l.notes) rootStyle.setProperty('--notes-w', l.notes + 'px');
  if (l.ed)    rootStyle.setProperty('--ed-w',    l.ed    + '%');
}
let layout = {};
try { layout = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch {}
applyLayout(layout);

function makeResizer(handle, compute) {
  let active = false;
  handle.addEventListener('pointerdown', (e) => {
    active = true;
    handle.classList.add('active');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!active) return;
    compute(e.clientX);
    applyLayout(layout);
  });
  const stop = () => {
    if (!active) return;
    active = false;
    handle.classList.remove('active');
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
    fitCanvas(); // paper width changes with the split
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

makeResizer($('#rz-rail'), (x) => {
  layout.rail = Math.min(340, Math.max(150, Math.round(x)));
});
makeResizer($('#rz-notes'), (x) => {
  const railW = document.querySelector('.rail').offsetWidth;
  layout.notes = Math.min(440, Math.max(200, Math.round(x - railW)));
});
makeResizer($('#rz-panes'), (x) => {
  const r = panes.getBoundingClientRect();
  layout.ed = Math.min(80, Math.max(20, ((x - r.left) / r.width) * 100)).toFixed(1);
});

// ───────────────────────────── keyboard ──────────────────────────────────
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#add-note').click(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openCodeDialog(); }
  if (inkMode && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); inkUndo(); }
  if (inkMode && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); inkRedo(); }
  if (e.key === 'Escape' && peSession) { commitPaperEdit(); return; }
  if (e.key === 'Escape' && !overlay.hidden) closeCodeDialog();
});

// ───────────────────────────── boot ──────────────────────────────────────
const WELCOME = `# Welcome to Inkwell ✒

Your notes now live on a server, so **every device sees the same page** — open this
on your laptop and your tablet at once and watch them stay in step.

## Code blocks
Press **{ } Code block** (or \`Ctrl+Shift+K\`), pick a language, paste your snippet:

\`\`\`python
def greet(name):
    return f"Hello, {name}!"
\`\`\`

## Ink
Press **✎ Ink** (top right) and draw straight onto this page — pen pressure shapes
the line. Draw on the tablet and the stroke appears on the laptop *while you draw it*.

- ↶ / ↷ undo and redo ink
- ☝ palm rejection ignores finger touches
- **Export** downloads the note as Markdown
`;

(async function boot() {
  await new Promise(res => socket.on('connect', res));
  notebooks = await api('/notebooks') || [];
  notesMeta = await api('/notes') || [];
  if (notesMeta.length === 0) {
    const id = 'n-welcome-' + Date.now();
    const w = { id, notebookId: notebooks[0] && notebooks[0].id, title: 'Welcome to Inkwell',
                body: WELCOME, strokes: [], created: Date.now(), updated: Date.now() };
    await api('/notes/' + id, { method: 'PUT', body: JSON.stringify(w) });
    notesMeta = [{ ...w, preview: w.body.slice(0, 120), hasInk: false }];
  }
  renderNotebooks();
  renderNotes();
  if (notesMeta.length) openNote(notesMeta[0].id);
})();
