/**
 * Sunday Quran Class – Hifdh Tracker (Google Apps Script web app)
 *
 * Everything that runs on Google's servers lives in this file:
 *   1. Web app routing (doGet) and HTML includes
 *   2. The persistence layer – a small repository over the bound Google Sheet
 *      (tabs "Students", "Sessions", "Config")
 *   3. The API the pages call through google.script.run
 *
 * The browser keeps no records of its own: each page loads the data from the
 * Sheet, and every change is validated and written here, under a script lock.
 *
 * Functions whose names end in "_" are private: google.script.run cannot call them.
 */

// =====================================================================
// Configuration
// =====================================================================
const APP_TITLE = 'Sunday Quran Class';
const MAX_STUDENTS = 100;
const PHOTO_MAX_CHARS = 48000;      // one Sheets cell holds at most 50,000 characters
const CELL_LIMIT = 10000000;        // cells per spreadsheet
const LOCK_WAIT_MS = 20000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const CONTACTS = ['Father', 'Mother', 'Self'];
const GRADES = ['excellent', 'verygood', 'good', 'repeat'];
const ENTRY_TYPES = ['hifdh', 'murajah'];
const RANGE_MODES = ['ayah', 'page', 'surah'];
const TOTAL_AYAHS = 6236;
const TOTAL_PAGES = 604;

// ?page=<key> → HTML template file
const PAGES = {
  index:    { file: 'Index',    title: 'Roster' },
  register: { file: 'Register', title: 'Register student' },
  profile:  { file: 'Profile',  title: 'Student profile' },
  progress: { file: 'Progress', title: 'Hifdh progress' },
  murajah:  { file: 'Murajah',  title: 'Murajah progress' },
  history:  { file: 'History',  title: 'History' },
  backup:   { file: 'Backup',   title: 'Backup & data' },
};

// =====================================================================
// 1. Web app routing
// =====================================================================

/** Serves a page. The URL parameters are handed to the page, because the page runs in an iframe that can't see them. */
function doGet(e) {
  const raw = (e && e.parameter) || {};
  const params = {};
  Object.keys(raw).forEach((k) => {
    if (/^[A-Za-z]{1,20}$/.test(k)) params[k] = String(raw[k]).slice(0, 100);
  });
  const key = PAGES[params.page] ? params.page : 'index';
  params.page = key;

  const template = HtmlService.createTemplateFromFile(PAGES[key].file);
  template.boot = safeJson_({
    page: key,
    baseUrl: ScriptApp.getService().getUrl() || '',
    params: params,
    maxStudents: MAX_STUDENTS,
    photoMax: PHOTO_MAX_CHARS,
  });
  return template.evaluate()
    .setTitle(PAGES[key].title + ' · ' + APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');   // a <meta viewport> inside the page is ignored
}

/** Inserts a static HTML file (Styles, Header, Common, Quran) into a page template. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** JSON that is safe to print inside a <script> element. */
function safeJson_(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Run once from the Apps Script editor (Run ▸ setup): grants access to the Sheet
 * and creates the Students / Sessions / Config tabs with their header rows.
 */
function setup() {
  table_('students');
  table_('sessions');
  config_();
  Logger.log('Ready: ' + ss_().getUrl());
}

// =====================================================================
// 2. Persistence layer (Google Sheet)
// =====================================================================
//
// Columns are found by header name, so they can be reordered in the Sheet and extra
// columns can be added. Any column that's missing is appended on first use. Aliases
// match the headers written by the earlier version of this project, so a spreadsheet
// it created still loads.
//
// Types: int · text · date (yyyy-MM-dd) · stamp (ISO date-time) · json
// Text is written with a leading apostrophe so Sheets keeps it exactly as typed:
// no formulas, no dates, no numbers ("07700…" keeps its zero, "+44…" isn't a formula).

const TABLES = {
  students: {
    sheet: 'Students',
    fields: [
      { key: 'id',        header: 'ID',             type: 'int' },
      { key: 'name',      header: 'Name',           type: 'text' },
      { key: 'phone',     header: 'Contact Number', type: 'text',  aliases: ['Phone'] },
      { key: 'contact',   header: 'Contact',        type: 'text' },
      { key: 'startDate', header: 'Date Started',   type: 'date',  aliases: ['Start Date'] },
      { key: 'notes',     header: 'Teacher Notes',  type: 'text',  aliases: ['Notes'] },
      { key: 'createdAt', header: 'Created At',     type: 'stamp' },
      { key: 'updatedAt', header: 'Updated At',     type: 'stamp' },
      { key: 'photo',     header: 'Photo',          type: 'text' },
    ],
  },
  sessions: {
    sheet: 'Sessions',
    fields: [
      { key: 'id',        header: 'ID',                    type: 'int' },
      { key: 'studentId', header: 'Student ID',            type: 'int' },
      { key: 'date',      header: 'Date',                  type: 'date' },
      { key: 'type',      header: 'Type',                  type: 'text' },
      { key: 'mem',       header: 'New Memorisation',      type: 'text',  aliases: ['Mem'] },
      { key: 'rev',       header: 'Revision',              type: 'text',  aliases: ['Rev'] },
      { key: 'grade',     header: 'Grade',                 type: 'text' },
      { key: 'memory',    header: 'Memory Mistakes',       type: 'int' },
      { key: 'tajweed',   header: 'Tajweed Mistakes',      type: 'int' },
      { key: 'prompts',   header: 'Prompts',               type: 'int' },
      { key: 'note',      header: 'Note',                  type: 'text' },
      { key: 'pct',       header: 'Overall %',             type: 'int',   aliases: ['Overall Pct'] },
      { key: 'juz',       header: 'Juz % (JSON)',          type: 'json',  aliases: ['Juz Data (JSON)'] },
      { key: 'revJuz',    header: 'Juz Revised (JSON)',    type: 'json',  aliases: ['Rev Juz (JSON)'] },
      { key: 'revShare',  header: 'Revision Share (JSON)', type: 'json' },
      { key: 'ranges',    header: 'Ranges (JSON)',         type: 'json' },
      { key: 'createdAt', header: 'Created At',            type: 'stamp' },
    ],
  },
};
const CONFIG_SHEET = 'Config';

function ss_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This Apps Script project must be bound to the class Google Sheet (open the Sheet, then Extensions ▸ Apps Script).');
  return ss;
}

const tableCache_ = {};
/** Opens a table: its sheet, the column index of every field and the row width. Creates the sheet or missing headers on first use. */
function table_(key) {
  if (tableCache_[key]) return tableCache_[key];
  const def = TABLES[key];
  const ss = ss_();
  let sheet = ss.getSheetByName(def.sheet);
  if (!sheet) sheet = ss.insertSheet(def.sheet);

  const lastCol = sheet.getLastColumn();
  const headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim()) : [];
  const col = {};
  const missing = [];
  def.fields.forEach((f) => {
    let i = headers.indexOf(f.header);
    if (i < 0 && f.aliases) i = headers.findIndex((h) => f.aliases.indexOf(h) >= 0);
    if (i < 0) { i = headers.length + missing.length; missing.push(f.header); }
    col[f.key] = i;
  });
  const width = headers.length + missing.length;
  if (missing.length) {
    if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  }
  return (tableCache_[key] = { def: def, sheet: sheet, col: col, width: width });
}

function fromCell_(v, type) {
  if (Object.prototype.toString.call(v) === '[object Date]') {   // a date typed into the Sheet by hand
    return type === 'date' ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v.toISOString();
  }
  if (v === '' || v === null || v === undefined) return type === 'text' || type === 'date' || type === 'stamp' ? '' : null;
  switch (type) {
    case 'int': { const n = Number(v); return isFinite(n) ? Math.round(n) : null; }
    case 'json': try { return JSON.parse(String(v)); } catch (e) { return null; }
    case 'date': { const s = String(v).trim().slice(0, 10); return DATE_RE.test(s) ? s : ''; }
    default: return String(v);
  }
}

function toCell_(v, type) {
  if (v === null || v === undefined) return '';
  switch (type) {
    case 'int': { const n = Number(v); return isFinite(n) ? Math.round(n) : ''; }
    case 'json': return "'" + JSON.stringify(v);
    default: { const s = String(v); return s === '' ? '' : "'" + s; }
  }
}

/** Every record in a table, as objects; `_row` is the sheet row. Rows without an ID are ignored. */
function readRows_(key) {
  const t = table_(key);
  const n = t.sheet.getLastRow() - 1;
  if (n < 1) return [];
  const out = [];
  t.sheet.getRange(2, 1, n, t.width).getValues().forEach((row, i) => {
    const o = { _row: i + 2 };
    t.def.fields.forEach((f) => { o[f.key] = fromCell_(row[t.col[f.key]], f.type); });
    if (o.id !== null) out.push(o);
  });
  return out;
}

/** One column's values (rows 2…last): used to find rows without reading whole records. */
function columnValues_(key, field) {
  const t = table_(key);
  const n = t.sheet.getLastRow() - 1;
  if (n < 1) return [];
  return t.sheet.getRange(2, t.col[field] + 1, n, 1).getValues().map((r) => r[0]);
}

/** Sheet row of the record with this ID, or -1. */
function findRow_(key, id) {
  const i = columnValues_(key, 'id').findIndex((v) => v !== '' && Number(v) === Number(id));
  return i < 0 ? -1 : i + 2;
}

function maxId_(key) {
  return columnValues_(key, 'id').reduce((m, v) => (v !== '' && isFinite(Number(v)) ? Math.max(m, Number(v)) : m), 0);
}

function appendRows_(key, objects) {
  if (!objects.length) return;
  const t = table_(key);
  const sheet = t.sheet;
  const start = sheet.getLastRow() + 1;
  const short = start + objects.length - 1 - sheet.getMaxRows();
  if (short > 0) sheet.insertRowsAfter(sheet.getMaxRows(), short);
  const rows = objects.map((o) => {
    const row = new Array(t.width).fill('');
    t.def.fields.forEach((f) => { row[t.col[f.key]] = toCell_(o[f.key], f.type); });
    return row;
  });
  sheet.getRange(start, 1, rows.length, t.width).setValues(rows);
}

/** Writes only the fields present on `obj` (other columns, including any you add yourself, are left alone). */
function updateRow_(key, rowNum, obj) {
  const t = table_(key);
  const cells = t.def.fields
    .filter((f) => obj[f.key] !== undefined)
    .map((f) => [t.col[f.key], toCell_(obj[f.key], f.type)])
    .sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < cells.length;) {
    let j = i;
    while (j + 1 < cells.length && cells[j + 1][0] === cells[j][0] + 1) j++;
    t.sheet.getRange(rowNum, cells[i][0] + 1, 1, j - i + 1).setValues([cells.slice(i, j + 1).map((c) => c[1])]);
    i = j + 1;
  }
}

// Sheets refuses to delete every non-frozen row, so keep one blank row spare below the data.
function ensureSpareRow_(sheet) {
  if (sheet.getMaxRows() <= sheet.getLastRow()) sheet.insertRowAfter(sheet.getLastRow());
}

/** Deletes the rows whose `field` value passes the test, in contiguous blocks from the bottom up. */
function deleteRowsWhere_(key, field, test) {
  const rows = [];
  columnValues_(key, field).forEach((v, i) => { if (v !== '' && test(Number(v))) rows.push(i + 2); });
  if (!rows.length) return 0;
  const sheet = table_(key).sheet;
  ensureSpareRow_(sheet);
  rows.sort((a, b) => b - a);
  for (let i = 0; i < rows.length;) {
    let start = rows[i];
    let count = 1;
    while (i + count < rows.length && rows[i + count] === start - 1) { start--; count++; }
    sheet.deleteRows(start, count);
    i += count;
  }
  return rows.length;
}

function clearTable_(key) {
  const sheet = table_(key).sheet;
  const last = sheet.getLastRow();
  if (last < 2) return;
  ensureSpareRow_(sheet);
  sheet.deleteRows(2, last - 1);
}

// ---------- Config tab: Key | Value (seq = next record ID, shared by students and sessions) ----------
function config_() {
  const ss = ss_();
  let sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET);
    sheet.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]).setFontWeight('bold');
    sheet.getRange(2, 1, 2, 2).setValues([['seq', 1], ['version', 1]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readConfig_() {
  const sheet = config_();
  const n = sheet.getLastRow() - 1;
  const map = {};
  if (n > 0) sheet.getRange(2, 1, n, 2).getValues().forEach((r) => { const k = String(r[0]).trim(); if (k) map[k] = r[1]; });
  return map;
}

function writeConfig_(key, value) {
  const sheet = config_();
  const n = sheet.getLastRow() - 1;
  const keys = n > 0 ? sheet.getRange(2, 1, n, 1).getValues().map((r) => String(r[0]).trim()) : [];
  const i = keys.indexOf(key);
  if (i >= 0) sheet.getRange(i + 2, 2).setValue(value);
  else sheet.appendRow([key, value]);
}

/** Reserves `count` new record IDs. Never reuses an ID already in the Sheet, even after manual edits. */
function allocateIds_(count) {
  let seq = Math.max(Number(readConfig_().seq) || 1, maxId_('students') + 1, maxId_('sessions') + 1);
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(seq++);
  writeConfig_('seq', seq);
  return ids;
}

/** Runs a change while holding the script lock, so two teachers saving at once can't clash. */
function withLock_(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new Error('The class sheet is busy (someone else is saving). Please try again.');
  try {
    const result = work();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ---------- validation (the server never trusts what a page sends) ----------
const clamp_ = (v) => Math.max(0, Math.min(100, Math.round(Number(v)) || 0));
const cleanJuz_ = (a) => Array.from({ length: 30 }, (_, i) => clamp_(Array.isArray(a) ? a[i] : 0));
const overall_ = (j) => Math.round(j.reduce((t, v) => t + v, 0) / 30);
const str_ = (v, max) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);
const intIn_ = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const isDate_ = (v) => DATE_RE.test(String(v || ''));
const today_ = () => Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

// Older records only had one overall %. Convert it the way most classes memorise: from Juz 30 backwards.
function juzFromPct_(p) {
  const a = new Array(30).fill(0);
  let n = (clamp_(p) * 30) / 100;
  for (let k = 29; k >= 0 && n > 0.001; k--) { const v = Math.min(1, n); a[k] = Math.round(v * 100); n -= v; }
  return a;
}

function cleanRevJuz_(a) {
  if (!Array.isArray(a)) return [];
  const set = {};
  a.forEach((i) => { const n = intIn_(i, 0, 29); if (n !== null) set[n] = true; });
  return Object.keys(set).map(Number).sort((x, y) => x - y);
}

function cleanRanges_(a) {
  if (!Array.isArray(a)) return [];
  return a.slice(0, 20).map((r) => {
    if (!r || RANGE_MODES.indexOf(r.mode) < 0) return null;
    const a1 = intIn_(r.a1, 1, TOTAL_AYAHS);
    const a2 = intIn_(r.a2, 1, TOTAL_AYAHS);
    const from = intIn_(r.from, 1, TOTAL_PAGES);
    const to = intIn_(r.to, 1, TOTAL_PAGES);
    const s = intIn_(r.s, 1, 114);
    if (a1 === null || a2 === null || a2 < a1 || from === null || to === null) return null;
    if (r.mode === 'ayah' && s === null) return null;
    const out = { mode: r.mode, from: from, to: to, a1: a1, a2: a2 };
    if (s !== null) out.s = s;
    return out;
  }).filter(Boolean);
}

function cleanStudent_(x) {
  return {
    name: str_(x.name, 80),
    phone: String(x.phone === null || x.phone === undefined ? '' : x.phone).replace(/[^\d+ ()-]/g, '').trim().slice(0, 20),
    contact: CONTACTS.indexOf(x.contact) >= 0 ? x.contact : '',
    startDate: isDate_(x.startDate) ? String(x.startDate) : '',
    notes: str_(x.notes, 2000),
  };
}

function cleanPhoto_(p) {
  if (!p) return '';
  const s = String(p);
  if (s.length > PHOTO_MAX_CHARS) throw new Error('That photo is too large to store. Please choose a smaller one.');
  if (!PHOTO_RE.test(s)) throw new Error('Use a JPEG, PNG or WebP photo.');
  return s;
}

function cleanSession_(x) {
  const juz = Array.isArray(x.juz) ? cleanJuz_(x.juz) : juzFromPct_(x.pct);
  const m = x.mistakes;
  const count = (v) => intIn_(Math.round(Number(v) || 0), 0, 99) || 0;
  return {
    studentId: intIn_(x.studentId, 1, 1e12),
    type: ENTRY_TYPES.indexOf(x.type) >= 0 ? x.type : '',
    date: isDate_(x.date) ? String(x.date) : '',
    mem: str_(x.mem, 500),
    rev: str_(x.rev, 500),
    grade: GRADES.indexOf(x.grade) >= 0 ? x.grade : '',
    mistakes: m && typeof m === 'object' ? { memory: count(m.memory), tajweed: count(m.tajweed), prompts: count(m.prompts) } : null,
    note: str_(x.note, 300),
    juz: juz,
    pct: overall_(juz),
    revJuz: cleanRevJuz_(x.revJuz),
    revShare: Array.isArray(x.revShare) ? cleanJuz_(x.revShare) : null,
    ranges: cleanRanges_(x.ranges),
  };
}

// ---------- record ⇄ row shapes ----------
function sessionRow_(s) {
  const m = s.mistakes;
  return Object.assign({}, s, {
    memory: m ? m.memory : null,
    tajweed: m ? m.tajweed : null,
    prompts: m ? m.prompts : null,
  });
}

function sessionOut_(r) {
  const juz = Array.isArray(r.juz) ? cleanJuz_(r.juz) : juzFromPct_(r.pct);
  const hasMistakes = r.memory !== null || r.tajweed !== null || r.prompts !== null;
  const out = {
    id: r.id,
    studentId: r.studentId,
    type: ENTRY_TYPES.indexOf(r.type) >= 0 ? r.type : '',
    date: r.date || '',
    mem: r.mem || '',
    rev: r.rev || '',
    juz: juz,
    pct: overall_(juz),
    revJuz: cleanRevJuz_(r.revJuz),
    ranges: cleanRanges_(r.ranges),
    grade: GRADES.indexOf(r.grade) >= 0 ? r.grade : '',
    mistakes: hasMistakes ? { memory: r.memory || 0, tajweed: r.tajweed || 0, prompts: r.prompts || 0 } : null,
    note: r.note || '',
    createdAt: r.createdAt || '',
  };
  if (Array.isArray(r.revShare)) out.revShare = cleanJuz_(r.revShare);
  return out;
}

function studentOut_(r, withPhoto) {
  const s = {
    id: r.id,
    name: r.name || '',
    phone: r.phone || '',
    contact: r.contact || '',
    startDate: r.startDate || '',
    notes: r.notes || '',
    createdAt: r.createdAt || '',
    updatedAt: r.updatedAt || '',
    hasPhoto: !!r.photo,
  };
  if (withPhoto) s.photo = r.photo || '';
  return s;
}

// =====================================================================
// 3. API (called from the pages with google.script.run)
// =====================================================================

/** Everything a page needs, except photos (see getPhotos). */
function loadDatabase() {
  const cfg = readConfig_();
  return {
    version: 1,
    students: readRows_('students').map((r) => studentOut_(r, false)),
    sessions: readRows_('sessions').map(sessionOut_),
    settings: { exampleHidden: String(cfg.exampleHidden).toLowerCase() === 'true' },
  };
}

/** { studentId: photo data URL } for every student with a photo. Loaded after the page shows, as photos are large. */
function getPhotos() {
  const out = {};
  readRows_('students').forEach((r) => { if (r.photo) out[r.id] = r.photo; });
  return out;
}

/** Registers a student, plus an optional first entry (memorisation, revision, juz %) dated on their start date. */
function registerStudent(input, firstEntry) {
  input = input || {};
  const s = cleanStudent_(input);
  if (!s.name) throw new Error("Please enter the student's name.");
  if (!s.startDate) throw new Error('Please choose the first Sunday date.');
  const photo = cleanPhoto_(input.photo);
  const entry = firstEntry ? cleanSession_(Object.assign({}, firstEntry, { type: '', date: s.startDate })) : null;
  const hasEntry = !!entry && (entry.mem || entry.rev || entry.revJuz.length || entry.juz.some((v) => v > 0));

  return withLock_(() => {
    if (columnValues_('students', 'id').filter((v) => v !== '').length >= MAX_STUDENTS) {
      throw new Error('The class is limited to ' + MAX_STUDENTS + ' students.');
    }
    const ids = allocateIds_(hasEntry ? 2 : 1);
    const now = new Date().toISOString();
    const student = Object.assign({ id: ids[0] }, s, { photo: photo, createdAt: now, updatedAt: now });
    appendRows_('students', [student]);
    let session = null;
    if (hasEntry) {
      session = sessionRow_(Object.assign({}, entry, { id: ids[1], studentId: student.id, createdAt: now }));
      appendRows_('sessions', [session]);
    }
    return { student: studentOut_(student, false), session: session ? sessionOut_(session) : null };
  });
}

/**
 * Updates a student's details. `photo`: leave it out to keep the current photo, "" to remove it, or a data URL to replace it.
 * `progress` (optional) = { date, juz: [30 numbers], revJuz: [juz indexes] } from the profile's juz editor. It is saved as a
 * new entry with no memorisation / revision text, like the first entry made at registration, so History keeps the
 * earlier snapshot and the change can be undone by deleting that entry.
 * Returns { student, session } — session is null when no progress was sent.
 */
function updateStudent(input, progress) {
  input = input || {};
  const id = intIn_(input.id, 1, 1e12);
  if (id === null) throw new Error('Unknown student.');
  const s = cleanStudent_(input);
  if (!s.name) throw new Error('Name is required.');
  const patch = { name: s.name, phone: s.phone, contact: s.contact, notes: s.notes, updatedAt: new Date().toISOString() };
  if (s.startDate) patch.startDate = s.startDate;
  if (input.photo !== undefined) patch.photo = cleanPhoto_(input.photo);
  let entry = null;
  if (progress) {
    // Without a juz array cleanSession_ would fall back to juzFromPct_(undefined) — all zeros — and wipe the student's progress.
    if (!Array.isArray(progress.juz) || progress.juz.length !== 30) throw new Error('The juz progress could not be read. Please try again.');
    entry = cleanSession_({ studentId: id, type: '', date: progress.date, juz: progress.juz, revJuz: progress.revJuz });
    if (!entry.date) entry.date = today_();
  }

  return withLock_(() => {
    const row = findRow_('students', id);
    if (row < 0) throw new Error('This student no longer exists.');
    updateRow_('students', row, patch);
    const t = table_('students');
    const values = t.sheet.getRange(row, 1, 1, t.width).getValues()[0];
    const rec = {};
    t.def.fields.forEach((f) => { rec[f.key] = fromCell_(values[t.col[f.key]], f.type); });
    let session = null;
    if (entry) {
      session = sessionRow_(Object.assign({}, entry, { id: allocateIds_(1)[0], createdAt: new Date().toISOString() }));
      appendRows_('sessions', [session]);
    }
    return { student: studentOut_(rec, false), session: session ? sessionOut_(session) : null };
  });
}

/** Removes a student and all their entries. */
function deleteStudent(studentId) {
  const id = intIn_(studentId, 1, 1e12);
  if (id === null) throw new Error('Unknown student.');
  return withLock_(() => {
    const sessions = deleteRowsWhere_('sessions', 'studentId', (v) => v === id);
    deleteRowsWhere_('students', 'id', (v) => v === id);
    return { id: id, sessionsRemoved: sessions };
  });
}

/** Saves a Hifdh or Murajah entry captured on the Progress / Murajah pages. */
function addSession(input) {
  const e = cleanSession_(input || {});
  if (!e.type) throw new Error('Unknown entry type.');
  if (!e.date) throw new Error('Choose the date of this reading.');
  if (!e.ranges.length) throw new Error('Add at least one portion.');
  return withLock_(() => {
    if (e.studentId === null || findRow_('students', e.studentId) < 0) throw new Error('This student no longer exists.');
    const row = sessionRow_(Object.assign({}, e, { id: allocateIds_(1)[0], createdAt: new Date().toISOString() }));
    appendRows_('sessions', [row]);
    return sessionOut_(row);
  });
}

/** Deletes one Sunday entry. */
function deleteSession(sessionId) {
  const id = intIn_(sessionId, 1, 1e12);
  if (id === null) throw new Error('Unknown entry.');
  return withLock_(() => ({ id: id, removed: deleteRowsWhere_('sessions', 'id', (v) => v === id) }));
}

/** Class-wide settings (stored in the Config tab). */
function setSetting(key, value) {
  if (key !== 'exampleHidden') throw new Error('Unknown setting.');
  return withLock_(() => { writeConfig_(key, value === true ? 'true' : 'false'); return true; });
}

/** Where the records live, and how much of the spreadsheet's cell allowance is in use. */
function getStats() {
  const ss = ss_();
  let cells = 0;
  ss.getSheets().forEach((sh) => { cells += sh.getMaxRows() * sh.getMaxColumns(); });
  return { sheetName: ss.getName(), sheetUrl: ss.getUrl(), cellsUsed: cells, cellLimit: CELL_LIMIT };
}

/** Full backup, including photos. Same shape as the offline app's backup file, so either can restore the other's. */
function exportDatabase() {
  return {
    version: 1,
    seq: Number(readConfig_().seq) || 1,
    students: readRows_('students').map((r) => {
      const s = studentOut_(r, true);
      delete s.hasPhoto;
      return s;
    }),
    sessions: readRows_('sessions').map(sessionOut_),
    exportedAt: new Date().toISOString(),
  };
}

/** Replaces every record with the contents of a backup (this app's or the offline app's). */
function restoreDatabase(backup) {
  if (!backup || !Array.isArray(backup.students) || !Array.isArray(backup.sessions)) {
    throw new Error("That file isn't a valid Hifdh Tracker backup.");
  }
  const now = new Date().toISOString();
  const studentIds = {};
  const students = [];
  let droppedPhotos = 0;
  backup.students.forEach((x) => {
    const id = intIn_(x && x.id, 1, 1e12);
    if (id === null || studentIds[id]) return;
    const s = cleanStudent_(x);
    if (!s.name) return;
    let photo = '';
    try { photo = cleanPhoto_(x.photo); } catch (err) { droppedPhotos++; }
    studentIds[id] = true;
    students.push(Object.assign({ id: id }, s, { photo: photo, createdAt: str_(x.createdAt, 40) || now, updatedAt: now }));
  });

  let maxId = students.reduce((m, s) => Math.max(m, s.id), 0);
  backup.sessions.forEach((x) => { const id = intIn_(x && x.id, 1, 1e12); if (id !== null) maxId = Math.max(maxId, id); });
  const sessionIds = {};
  const sessions = [];
  backup.sessions.forEach((x) => {
    if (!x) return;
    const e = cleanSession_(x);
    if (!studentIds[e.studentId] || !e.date) return;
    let id = intIn_(x.id, 1, 1e12);
    if (id === null || sessionIds[id]) id = ++maxId;
    sessionIds[id] = true;
    sessions.push(sessionRow_(Object.assign({ id: id, createdAt: str_(x.createdAt, 40) || now }, e)));
  });

  return withLock_(() => {
    clearTable_('sessions');
    clearTable_('students');
    appendRows_('students', students);
    appendRows_('sessions', sessions);
    writeConfig_('seq', maxId + 1);
    return { db: loadDatabase(), droppedPhotos: droppedPhotos };
  });
}

/** Deletes every student and entry. The page must pass the word the teacher typed. */
function wipeDatabase(confirmation) {
  if (confirmation !== 'ERASE') throw new Error('Nothing was erased.');
  return withLock_(() => {
    clearTable_('sessions');
    clearTable_('students');
    return loadDatabase();
  });
}

// Four sample students with a few weeks of history (Backup page, and "Load demo students" on any empty page).
const DEMO_ = [
  ['Yusuf Ahmed', '+44777799999', 'Father', 'Strong tajweed; needs to slow down on madd.',
    [['2026-08-30', 'An-Naba 1–20', 'Al-Fajr to An-Nas', 8], ['2026-09-06', 'An-Naba 21–40', 'Al-Ghashiyah to An-Nas', 9],
     ['2026-09-13', "An-Nazi'at 1–26", 'An-Naba', 10], ['2026-09-20', "An-Nazi'at 27–46", 'An-Naba', 12]]],
  ['Musa Khan', '+44 7700 900214', 'Mother', 'Very consistent. Parents keen on weekly updates.',
    [['2026-09-06', 'Al-Mulk 1–10', "Juz 'Amma complete", 12], ['2026-09-13', 'Al-Mulk 11–20', 'Al-Mulk 1–10', 13],
     ['2026-09-20', 'Al-Mulk 21–30', 'Al-Mulk 1–20', 14]]],
  ['Ibrahim Siddiqui', '+44 7700 900358', 'Father', '', [['2026-09-13', "Al-A'la 1–19", 'Al-Fil to An-Nas', 3]]],
  ['Ayaan Rahman', '+44 7700 900471', 'Mother', 'Joined this term.', []],
];

function addDemoData() {
  return withLock_(() => {
    if (columnValues_('students', 'id').filter((v) => v !== '').length + DEMO_.length > MAX_STUDENTS) {
      throw new Error('Not enough room in the class for demo students.');
    }
    const ids = allocateIds_(DEMO_.reduce((t, d) => t + 1 + d[4].length, 0));
    const now = new Date().toISOString();
    const students = [];
    const sessions = [];
    let k = 0;
    DEMO_.forEach(([name, phone, contact, notes, list]) => {
      const id = ids[k++];
      students.push({ id: id, name: name, phone: phone, contact: contact, startDate: list.length ? list[0][0] : today_(), notes: notes, photo: '', createdAt: now, updatedAt: now });
      list.forEach(([date, mem, rev, pct]) => {
        const juz = juzFromPct_(pct);
        sessions.push(sessionRow_({ id: ids[k++], studentId: id, type: '', date: date, mem: mem, rev: rev, juz: juz, pct: overall_(juz),
          revJuz: /Mulk/.test(rev) ? [28] : [29], ranges: [], grade: '', mistakes: null, note: '', createdAt: now }));
      });
    });
    appendRows_('students', students);
    appendRows_('sessions', sessions);
    return loadDatabase();
  });
}
