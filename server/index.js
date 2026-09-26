const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const MAX_CHAT = 500;
const MAX_DM_THREAD = 500;
const JWT_SECRET = process.env.JWT_SECRET || 'tarkventum-dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d';

// App-level administrators (not the same as room role "admin").
// Override with env TARKVENTUM_ADMINS=user1,user2 (comma-separated, case-insensitive).
const ADMIN_USERNAMES = (process.env.TARKVENTUM_ADMINS || 'DoTenN')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAppAdmin(userOrUsername) {
  if (!userOrUsername) return false;
  const un = String(
    typeof userOrUsername === 'string' ? userOrUsername : (userOrUsername.username || '')
  ).trim().toLowerCase();
  return !!un && ADMIN_USERNAMES.includes(un);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');
const PERSONAL_KANBAN_FILE = path.join(DATA_DIR, 'personal-kanban.json');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const ROOM_SAVE_DEBOUNCE_MS = 400;
const MAX_AVATAR_BYTES = 800 * 1024;
const MAX_CANVAS_IMAGE_BYTES = 3 * 1024 * 1024;

const app = express();
const server = http.createServer(app);
// maxHttpBufferSize: room import / large pencil strokes can exceed the 1 MB default,
// which made socket.io silently drop the connection ("app crashed").
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 25 * 1024 * 1024 });

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/avatars', express.static(AVATARS_DIR, {
  fallthrough: false,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));
app.use('/uploads', express.static(UPLOADS_DIR, {
  fallthrough: false,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));
app.get('/r/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/** @type {Map<string, object>} */
const rooms = new Map();

/** accountId -> Set<socketId> */
const onlineByAccount = new Map();
/** socketId -> accountId */
const accountBySocket = new Map();

const DEFAULT_COLUMNS = [
  { id: 'col-backlog', title: 'Бэклог', order: 0 },
  { id: 'col-progress', title: 'В работе', order: 1 },
  { id: 'col-done', title: 'Готово', order: 2 },
];

const USER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#9b59b6',
  '#f39c12', '#1abc9c', '#e67e22', '#34495e',
  '#e91e63', '#00bcd4',
];

// ---------- Persistence ----------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripBom(raw));
  } catch (err) {
    console.error('loadJson', file, err.message);
    return fallback;
  }
}

/** Windows Notepad saves UTF-8 with a BOM, which JSON.parse rejects. */
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function saveJson(file, data) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadUsersStore() {
  const data = loadJson(USERS_FILE, { users: [] });
  if (!Array.isArray(data.users)) data.users = [];
  return data;
}

function saveUsersStore(store) {
  saveJson(USERS_FILE, store);
}

function loadDmsStore() {
  const data = loadJson(DMS_FILE, { threads: {}, unread: {} });
  if (!data.threads || typeof data.threads !== 'object') data.threads = {};
  if (!data.unread || typeof data.unread !== 'object') data.unread = {};
  return data;
}

function saveDmsStore(store) {
  saveJson(DMS_FILE, store);
}

ensureDataDir();
let usersStore = loadUsersStore();
let dmsStore = loadDmsStore();

function loadPersonalKanbanStore() {
  const data = loadJson(PERSONAL_KANBAN_FILE, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function savePersonalKanbanStore() {
  saveJson(PERSONAL_KANBAN_FILE, personalKanbanStore);
}

/** @type {Record<string, { columns: object[], cards: object[] }>} */
let personalKanbanStore = loadPersonalKanbanStore();

function getPersonalBoard(userId) {
  if (!personalKanbanStore[userId]) {
    personalKanbanStore[userId] = {
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      cards: [],
    };
  }
  const board = personalKanbanStore[userId];
  if (!Array.isArray(board.columns) || board.columns.length === 0) {
    board.columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));
  }
  if (!Array.isArray(board.cards)) board.cards = [];
  return board;
}

function personalBoardPublic(userId) {
  const board = getPersonalBoard(userId);
  return { columns: board.columns, cards: board.cards };
}

function normalizeBoardCard(card, board, fallbackColumnId) {
  const columnId = card.columnId || fallbackColumnId || board.columns[0]?.id;
  return {
    id: card.id || genId('card'),
    columnId,
    title: String(card.title || 'Новая карточка').slice(0, 200),
    description: String(card.description || '').slice(0, 2000),
    dueDate: card.dueDate ? String(card.dueDate).slice(0, 32) : null,
    linkedRoomId: card.linkedRoomId ? normalizeRoomId(card.linkedRoomId) : null,
    order: typeof card.order === 'number'
      ? card.order
      : board.cards.filter((c) => c.columnId === columnId).length,
  };
}

function findUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  return usersStore.users.find((x) => x.username === u) || null;
}

function findUserById(id) {
  return usersStore.users.find((x) => x.id === id) || null;
}

function detectImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'webp';
  return null;
}

function avatarUrlFor(u) {
  if (!u || !u.avatarUpdatedAt || !u.avatarExt) return null;
  return `/avatars/${u.id}.${u.avatarExt}?v=${u.avatarUpdatedAt}`;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    avatarUrl: avatarUrlFor(u),
    isAdmin: isAppAdmin(u),
  };
}

function removeUserAvatarFiles(userId, keepExt) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    if (keepExt && ext === keepExt) continue;
    const fp = path.join(AVATARS_DIR, `${userId}.${ext}`);
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (err) {
      console.error('avatar unlink', fp, err.message);
    }
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) return null;
    return user;
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Требуется вход' });
  }
  req.user = user;
  next();
}

function normalizeUsername(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(s)) return null;
  return s;
}

function threadKey(a, b) {
  return [a, b].sort().join(':');
}

function getUnreadFor(userId, otherId) {
  const map = dmsStore.unread[userId] || {};
  return map[otherId] || 0;
}

function setUnread(userId, otherId, count) {
  if (!dmsStore.unread[userId]) dmsStore.unread[userId] = {};
  if (count <= 0) delete dmsStore.unread[userId][otherId];
  else dmsStore.unread[userId][otherId] = count;
}

function bumpUnread(userId, otherId) {
  setUnread(userId, otherId, getUnreadFor(userId, otherId) + 1);
}

function totalUnread(userId) {
  const map = dmsStore.unread[userId] || {};
  return Object.values(map).reduce((s, n) => s + (n || 0), 0);
}

function markOnline(accountId, socketId) {
  if (!onlineByAccount.has(accountId)) onlineByAccount.set(accountId, new Set());
  onlineByAccount.get(accountId).add(socketId);
  accountBySocket.set(socketId, accountId);
}

function markOffline(socketId) {
  const accountId = accountBySocket.get(socketId);
  if (!accountId) return;
  accountBySocket.delete(socketId);
  const set = onlineByAccount.get(accountId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) onlineByAccount.delete(accountId);
  }
}

function isOnline(accountId) {
  const set = onlineByAccount.get(accountId);
  return !!(set && set.size > 0);
}

function emitToAccount(accountId, event, payload) {
  const set = onlineByAccount.get(accountId);
  if (!set) return;
  for (const sid of set) {
    io.to(sid).emit(event, payload);
  }
}

function broadcastPresence() {
  const onlineIds = [...onlineByAccount.keys()];
  io.emit('users-presence', { onlineIds });
}

// ---------- Auth API ----------
app.post('/api/register', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || '');
    const displayName = String(req.body?.displayName || username || '').trim().slice(0, 32);

    if (!username) {
      return res.status(400).json({
        ok: false,
        error: 'Логин: 3–24 символа, латиница, цифры и _',
      });
    }
    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ ok: false, error: 'Пароль: от 6 до 128 символов' });
    }
    if (findUserByUsername(username)) {
      return res.status(409).json({ ok: false, error: 'Такой логин уже занят' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: genId('usr'),
      username,
      displayName: displayName || username,
      passwordHash,
      createdAt: Date.now(),
    };
    usersStore.users.push(user);
    saveUsersStore(usersStore);

    const token = signToken(user);
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (err) {
    console.error('register', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Введите логин и пароль' });
    }
    const user = findUserByUsername(username);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
    }
    const token = signToken(user);
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (err) {
    console.error('login', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/api/me/avatar', authMiddleware, (req, res) => {
  try {
    const image = req.body?.image;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ ok: false, error: 'Нужно поле image (data URL)' });
    }
    const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(image.trim());
    if (!m) {
      return res.status(400).json({ ok: false, error: 'Допустимы только PNG, JPEG, WebP или GIF' });
    }
    const declared = m[2].toLowerCase() === 'jpg' ? 'jpeg' : m[2].toLowerCase();
    const b64 = m[3].replace(/\s+/g, '');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'Не удалось декодировать изображение' });
    }
    if (!buf.length) {
      return res.status(400).json({ ok: false, error: 'Пустое изображение' });
    }
    if (buf.length > MAX_AVATAR_BYTES) {
      return res.status(400).json({ ok: false, error: 'Файл слишком большой (макс. ~800 КБ)' });
    }
    const detected = detectImageExt(buf);
    if (!detected) {
      return res.status(400).json({ ok: false, error: 'Файл не является допустимым изображением' });
    }
    // Map jpeg declaration to jpg file ext; detected already jpg/png/gif/webp
    const ext = detected === 'jpg' ? 'jpg' : detected;
    if (
      (declared === 'png' && ext !== 'png')
      || (declared === 'jpeg' && ext !== 'jpg')
      || (declared === 'webp' && ext !== 'webp')
      || (declared === 'gif' && ext !== 'gif')
    ) {
      // Still allow if magic matches a known image type; use detected
    }

    ensureDataDir();
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ ok: false, error: 'Требуется вход' });

    removeUserAvatarFiles(user.id, ext);
    const dest = path.join(AVATARS_DIR, `${user.id}.${ext}`);
    fs.writeFileSync(dest, buf);

    user.avatarExt = ext;
    user.avatarUpdatedAt = Date.now();
    saveUsersStore(usersStore);

    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error('avatar upload', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.delete('/api/me/avatar', authMiddleware, (req, res) => {
  try {
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ ok: false, error: 'Требуется вход' });
    removeUserAvatarFiles(user.id, null);
    delete user.avatarExt;
    delete user.avatarUpdatedAt;
    saveUsersStore(usersStore);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error('avatar delete', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});


app.patch('/api/me', authMiddleware, (req, res) => {
  try {
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ ok: false, error: 'Не авторизован' });
    const body = req.body || {};
    if (body.displayName != null) {
      const dn = String(body.displayName || '').trim().slice(0, 48);
      if (!dn) return res.status(400).json({ ok: false, error: 'Укажите отображаемое имя' });
      user.displayName = dn;
    }
    if (body.username != null) {
      const un = String(body.username || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
      if (un.length < 3) return res.status(400).json({ ok: false, error: 'Логин: минимум 3 символа (a-z, 0-9, _, -)' });
      const taken = usersStore.users.find((u) => u.username === un && u.id !== user.id);
      if (taken) return res.status(400).json({ ok: false, error: 'Такой логин уже занят' });
      user.username = un;
    }
    saveUsersStore(usersStore);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error('patch /api/me', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.post('/api/me/password', authMiddleware, async (req, res) => {
  try {
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ ok: false, error: 'Не авторизован' });
    const currentPassword = String((req.body && req.body.currentPassword) || '');
    const newPassword = String((req.body && req.body.newPassword) || '');
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: 'Укажите текущий и новый пароль' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'Новый пароль: минимум 6 символов' });
    }
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(400).json({ ok: false, error: 'Неверный текущий пароль' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    saveUsersStore(usersStore);
    res.json({ ok: true });
  } catch (err) {
    console.error('password change', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.post('/api/canvas-image', authMiddleware, (req, res) => {
  try {
    const image = req.body?.image;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ ok: false, error: 'Нужно поле image (data URL)' });
    }
    const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(image.trim());
    if (!m) {
      return res.status(400).json({ ok: false, error: 'Допустимы только PNG, JPEG, WebP или GIF' });
    }
    const b64 = m[3].replace(/\s+/g, '');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'Не удалось декодировать изображение' });
    }
    if (!buf.length) {
      return res.status(400).json({ ok: false, error: 'Пустое изображение' });
    }
    if (buf.length > MAX_CANVAS_IMAGE_BYTES) {
      return res.status(400).json({ ok: false, error: 'Файл слишком большой (макс. ~3 МБ)' });
    }
    const detected = detectImageExt(buf);
    if (!detected) {
      return res.status(400).json({ ok: false, error: 'Файл не является допустимым изображением' });
    }
    const ext = detected === 'jpg' ? 'jpg' : detected;
    ensureDataDir();
    const id = genId('img');
    const filename = `${id}.${ext}`;
    const dest = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(dest, buf);
    const url = `/uploads/${filename}`;
    res.json({ ok: true, url });
  } catch (err) {
    console.error('canvas-image upload', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.get('/api/rooms/public', authMiddleware, (req, res) => {
  try {
    res.json({ ok: true, rooms: listPublicRooms() });
  } catch (err) {
    console.error('rooms/public', err);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.get('/api/users', authMiddleware, (req, res) => {
  const list = usersStore.users
    .filter((u) => u.id !== req.user.id)
    .map((u) => ({
      ...publicUser(u),
      online: isOnline(u.id),
      unread: getUnreadFor(req.user.id, u.id),
    }));
  res.json({
    ok: true,
    users: list,
    totalUnread: totalUnread(req.user.id),
  });
});

app.get('/api/dms/:otherId', authMiddleware, (req, res) => {
  const other = findUserById(req.params.otherId);
  if (!other) return res.status(404).json({ ok: false, error: 'Пользователь не найден' });
  const key = threadKey(req.user.id, other.id);
  const messages = dmsStore.threads[key] || [];
  res.json({ ok: true, messages, other: publicUser(other) });
});

// ---------- Rooms ----------
function normalizeRoomId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

function createRoom(id, { ownerId = null, visibility = 'public', title = '' } = {}) {
  return {
    id,
    title: String(title || '').slice(0, 80),
    ownerId: ownerId || null,
    visibility: visibility === 'private' ? 'private' : 'public',
    members: [], // { userId, role: 'member'|'editor'|'admin' }
    objects: [],
    connectors: [],
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    cards: [],
    messages: [],
    users: new Map(),
  };
}

const roomSaveTimers = new Map();

function roomFilePath(roomId) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  return path.join(ROOMS_DIR, `${id}.json`);
}

function serializeRoom(room) {
  if (!room) return null;
  if (Array.isArray(room.messages) && room.messages.length > MAX_CHAT) {
    room.messages = room.messages.slice(-MAX_CHAT);
  }
  return {
    id: room.id,
    title: room.title || '',
    ownerId: room.ownerId || null,
    visibility: room.visibility === 'private' ? 'private' : 'public',
    members: Array.isArray(room.members) ? room.members : [],
    objects: Array.isArray(room.objects) ? room.objects : [],
    connectors: Array.isArray(room.connectors) ? room.connectors : [],
    columns: Array.isArray(room.columns) && room.columns.length
      ? room.columns
      : DEFAULT_COLUMNS.map((c) => ({ ...c })),
    cards: Array.isArray(room.cards) ? room.cards : [],
    messages: Array.isArray(room.messages) ? room.messages.slice(-MAX_CHAT) : [],
    updatedAt: Date.now(),
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function finiteOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Make an object from a file/import safe to store and render.
 * Returns null for entries that cannot be drawn at all.
 */
function sanitizeBoardObject(raw) {
  if (!isPlainObject(raw)) return null;
  const o = { ...raw };
  if (typeof o.id !== 'string' || !o.id) o.id = genId('obj');
  if (typeof o.type !== 'string' || !o.type) return null;
  if (o.type === 'pen') {
    if (!Array.isArray(o.points)) return null;
    o.points = o.points
      .filter((p) => isPlainObject(p))
      .map((p) => ({ x: finiteOr(p.x, 0), y: finiteOr(p.y, 0) }));
    if (o.points.length < 1) return null;
  } else if (o.type === 'line' || o.type === 'arrow') {
    o.x1 = finiteOr(o.x1, 0); o.y1 = finiteOr(o.y1, 0);
    o.x2 = finiteOr(o.x2, o.x1 + 100); o.y2 = finiteOr(o.y2, o.y1);
  } else {
    o.x = finiteOr(o.x, 0);
    o.y = finiteOr(o.y, 0);
    if (o.w != null) o.w = finiteOr(o.w, 100);
    if (o.h != null) o.h = finiteOr(o.h, 60);
  }
  if (o.rotation != null) o.rotation = finiteOr(o.rotation, 0);
  if (o.strokeWidth != null) o.strokeWidth = Math.max(0.5, Math.min(64, finiteOr(o.strokeWidth, 2)));
  if (o.fontSize != null && o.fontSize !== '') o.fontSize = finiteOr(o.fontSize, 14);
  if (o.columns != null) {
    o.columns = Array.isArray(o.columns)
      ? o.columns.filter(isPlainObject).map((c) => ({
        ...c,
        name: String(c.name == null ? '' : c.name),
        type: String(c.type == null ? '' : c.type),
        pk: !!c.pk,
      }))
      : undefined;
  }
  if (o.text != null && typeof o.text !== 'string') o.text = String(o.text);
  if (o.label != null && typeof o.label !== 'string') o.label = String(o.label);
  if (o.parentId != null && typeof o.parentId !== 'string') o.parentId = null;
  return o;
}

function sanitizeConnector(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.fromId !== 'string' || typeof raw.toId !== 'string') return null;
  if (!raw.fromId || !raw.toId || raw.fromId === raw.toId) return null;
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId('conn'),
    type: 'connector',
    stroke: typeof raw.stroke === 'string' ? raw.stroke : '#64748b',
    strokeWidth: Math.max(0.5, Math.min(64, finiteOr(raw.strokeWidth, 2))),
  };
}

/** Chat messages: accept several key names / shapes found in exports and hand-edited files. */
function pickRawMessages(data) {
  if (!isPlainObject(data)) return [];
  for (const key of ['messages', 'chat', 'chatMessages', 'roomMessages']) {
    const v = data[key];
    if (Array.isArray(v)) return v;
    if (isPlainObject(v) && Array.isArray(v.messages)) return v.messages;
  }
  return [];
}

function sanitizeMessage(raw, roomId) {
  if (!isPlainObject(raw)) return null;
  const text = String(raw.text == null ? (raw.message == null ? '' : raw.message) : raw.text).slice(0, 1000);
  if (!text.trim()) return null;
  let ts = raw.ts != null ? raw.ts : (raw.time != null ? raw.time : raw.createdAt);
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    ts = Number.isFinite(parsed) ? parsed : Number(ts);
  }
  ts = finiteOr(ts, Date.now());
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId('msg'),
    name: String(raw.name == null ? (raw.author || raw.userName || 'Гость') : raw.name).slice(0, 48),
    color: typeof raw.color === 'string' ? raw.color : '#93c5fd',
    text,
    ts,
    roomId: roomId || raw.roomId || null,
  };
}

function normalizeMessages(list, roomId) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = sanitizeMessage(raw, roomId);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-MAX_CHAT);
}

/**
 * Build a room from saved data. Accepts both the room file format ({ id, messages, ... })
 * and the client export format ({ roomId, messages, ... }). `fallbackId` = file name.
 */
function hydrateRoom(data, fallbackId) {
  if (!isPlainObject(data)) return null;
  const id = normalizeRoomId(data.id) || normalizeRoomId(fallbackId) || normalizeRoomId(data.roomId);
  if (!id) return null;
  const room = createRoom(id, {
    ownerId: data.ownerId || null,
    visibility: data.visibility || 'public',
    title: typeof data.title === 'string' && data.title !== data.roomId ? data.title : '',
  });
  room.members = Array.isArray(data.members) ? data.members.filter(isPlainObject) : [];
  room.objects = (Array.isArray(data.objects) ? data.objects : []).map(sanitizeBoardObject).filter(Boolean);
  room.connectors = (Array.isArray(data.connectors) ? data.connectors : []).map(sanitizeConnector).filter(Boolean);
  room.columns = Array.isArray(data.columns) && data.columns.filter(isPlainObject).length
    ? data.columns.filter(isPlainObject)
    : DEFAULT_COLUMNS.map((c) => ({ ...c }));
  room.cards = Array.isArray(data.cards) ? data.cards.filter(isPlainObject) : [];
  room.messages = normalizeMessages(pickRawMessages(data), id);
  room.users = new Map(); // presence is ephemeral
  return room;
}

function fileMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * Load a room file. If the file exists but cannot be parsed (e.g. a hand edit left a
 * trailing comma), it is renamed to *.broken-<time>.bak instead of being silently
 * overwritten with an empty room (that overwrite was a real data-loss path).
 */
function loadRoomFromDisk(roomId) {
  const file = roomFilePath(roomId);
  if (!file || !fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    const backup = `${file}.broken-${Date.now()}.bak`;
    try { fs.renameSync(file, backup); } catch { /* ignore */ }
    console.error(`Room file ${file} is not valid JSON (${err.message}). Moved to ${backup} — fix it and rename back to .json (with the server stopped).`);
    return null;
  }
  const room = hydrateRoom(data, path.basename(file, '.json'));
  if (!room) {
    console.error(`Room file ${file} has no usable room data; left untouched.`);
    return null;
  }
  room._diskMtime = fileMtime(file);
  return room;
}

function saveRoomToDisk(room) {
  if (!room || !room.id) return;
  const file = roomFilePath(room.id);
  if (!file) return;
  try {
    saveJson(file, serializeRoom(room));
    room._diskMtime = fileMtime(file);
  } catch (err) {
    console.error('saveRoomToDisk', room.id, err.message);
  }
}

/**
 * If nobody is in the room and its file was edited on disk after our last save,
 * reload it so manual edits (e.g. restored chat messages) are picked up.
 */
function maybeReloadRoomFromDisk(id) {
  const room = rooms.get(id);
  if (!room || room.users.size > 0 || roomSaveTimers.has(id)) return room;
  const file = roomFilePath(id);
  if (!file || !fs.existsSync(file)) return room;
  const mtime = fileMtime(file);
  if (!room._diskMtime || mtime <= room._diskMtime + 1) return room;
  const fresh = loadRoomFromDisk(id);
  if (!fresh) return room;
  console.log(`Room ${id}: file changed on disk, reloaded (${fresh.messages.length} messages).`);
  rooms.set(id, fresh);
  return fresh;
}

function deleteRoomFromDisk(roomId) {
  const file = roomFilePath(roomId);
  if (!file) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.error('deleteRoomFromDisk', roomId, err.message);
  }
}

function scheduleRoomSave(roomOrId, { immediate = false } = {}) {
  const id = normalizeRoomId(
    typeof roomOrId === 'string' ? roomOrId : (roomOrId && roomOrId.id)
  );
  if (!id) return;
  const prev = roomSaveTimers.get(id);
  if (prev) {
    clearTimeout(prev);
    roomSaveTimers.delete(id);
  }
  const flush = () => {
    roomSaveTimers.delete(id);
    const room = rooms.get(id);
    if (room) saveRoomToDisk(room);
  };
  if (immediate) {
    flush();
    return;
  }
  roomSaveTimers.set(id, setTimeout(flush, ROOM_SAVE_DEBOUNCE_MS));
}

function flushAllRoomSaves() {
  for (const [id, timer] of [...roomSaveTimers.entries()]) {
    clearTimeout(timer);
    roomSaveTimers.delete(id);
    const room = rooms.get(id);
    if (room) saveRoomToDisk(room);
  }
}

function loadAllRoomsFromDisk() {
  ensureDataDir();
  let count = 0;
  try {
    for (const name of fs.readdirSync(ROOMS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const id = normalizeRoomId(name.slice(0, -5));
      if (!id || rooms.has(id)) continue;
      const room = loadRoomFromDisk(id);
      if (room) {
        rooms.set(id, room);
        count += 1;
        console.log(`  room ${id}: ${room.objects.length} objects, ${room.messages.length} chat messages`);
      }
    }
  } catch (err) {
    console.error('loadAllRoomsFromDisk', err.message);
  }
  console.log(`Loaded ${count} persisted room(s) from ${ROOMS_DIR}`);
}

function getOrCreateRoom(roomId, opts) {
  const id = normalizeRoomId(roomId);
  if (!id) {
    // keep previous behaviour for callers that already normalized
    if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId, opts || {}));
    return rooms.get(roomId);
  }
  if (rooms.has(id)) return maybeReloadRoomFromDisk(id);
  const loaded = loadRoomFromDisk(id);
  if (loaded) {
    rooms.set(id, loaded);
    return loaded;
  }
  const room = createRoom(id, opts || {});
  rooms.set(id, room);
  scheduleRoomSave(room, { immediate: true });
  return room;
}


function canAccessRoom(room, accountId) {
  if (!room) return false;
  if (room.visibility !== 'private') return true;
  if (!accountId) return false;
  if (room.ownerId && room.ownerId === accountId) return true;
  const members = Array.isArray(room.members) ? room.members : [];
  return members.some((m) => m && m.userId === accountId);
}

function getMemberRole(room, accountId) {
  if (!room || !accountId) return null;
  if (room.ownerId === accountId) return 'owner';
  const members = Array.isArray(room.members) ? room.members : [];
  const m = members.find((x) => x && x.userId === accountId);
  return m ? (m.role || 'member') : null;
}

function membersPublic(room) {
  const list = [];
  if (room.ownerId) {
    const u = findUserById(room.ownerId);
    list.push({
      userId: room.ownerId,
      role: 'owner',
      displayName: u ? (u.displayName || u.username) : 'Владелец',
      username: u ? u.username : '',
      avatarUrl: u ? avatarUrlFor(u) : null,
    });
  }
  for (const m of (room.members || [])) {
    if (!m || !m.userId || m.userId === room.ownerId) continue;
    const u = findUserById(m.userId);
    list.push({
      userId: m.userId,
      role: m.role || 'member',
      displayName: u ? (u.displayName || u.username) : m.userId,
      username: u ? u.username : '',
      avatarUrl: u ? avatarUrlFor(u) : null,
    });
  }
  return list;
}

function listPublicRooms() {
  const out = [];
  for (const room of rooms.values()) {
    if (room.visibility === 'private') continue;
    const owner = room.ownerId ? findUserById(room.ownerId) : null;
    out.push({
      id: room.id,
      title: room.title || room.id,
      visibility: 'public',
      ownerId: room.ownerId || null,
      ownerName: owner ? (owner.displayName || owner.username) : null,
      userCount: room.users.size,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function roomPublicState(room) {
  return {
    objects: room.objects,
    connectors: room.connectors,
    columns: room.columns,
    cards: room.cards,
    messages: room.messages,
    ownerId: room.ownerId || null,
    visibility: room.visibility || 'public',
    title: room.title || '',
    members: membersPublic(room),
    users: Array.from(room.users.values()).map((u) => ({
      id: u.id,
      accountId: u.accountId,
      name: u.name,
      color: u.color,
      cursor: u.cursor,
    })),
  };
}

function pickColor(room) {
  const used = new Set(Array.from(room.users.values()).map((u) => u.color));
  for (const c of USER_COLORS) {
    if (!used.has(c)) return c;
  }
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCard(card, room, fallbackColumnId) {
  const columnId = card.columnId || fallbackColumnId || room.columns[0]?.id;
  return {
    id: card.id || genId('card'),
    columnId,
    title: String(card.title || 'Новая карточка').slice(0, 200),
    description: String(card.description || '').slice(0, 2000),
    dueDate: card.dueDate ? String(card.dueDate).slice(0, 32) : null,
    linkedRoomId: card.linkedRoomId ? normalizeRoomId(card.linkedRoomId) : null,
    order: typeof card.order === 'number'
      ? card.order
      : room.cards.filter((c) => c.columnId === columnId).length,
  };
}

/** Merge exported room data into a live room. Returns counts for the UI. */
function importIntoRoom(room, data, mode) {
  const summary = { objects: 0, connectors: 0, messages: 0, cards: 0, skipped: 0 };
  const hasObjects = Array.isArray(data.objects);
  const incomingObjs = (hasObjects ? data.objects : []).map(sanitizeBoardObject);
  summary.skipped += incomingObjs.filter((o) => !o).length;
  const objs = incomingObjs.filter(Boolean);

  if (mode === 'replace' && hasObjects) {
    room.objects = [];
    room.connectors = [];
  }
  const taken = new Set(room.objects.map((o) => o.id));
  const idMap = new Map();
  for (const o of objs) {
    const oldId = o.id;
    let newId = oldId;
    if (taken.has(newId) || idMap.has(oldId)) newId = genId('obj');
    idMap.set(oldId, newId);
    taken.add(newId);
  }
  for (const o of objs) {
    const copy = { ...o, id: idMap.get(o.id) || o.id };
    if (copy.parentId) copy.parentId = idMap.get(copy.parentId) || null;
    room.objects.push(copy);
    summary.objects += 1;
  }
  const objIds = new Set(room.objects.map((o) => o.id));
  const connTaken = new Set(room.connectors.map((c) => c.id));
  for (const raw of Array.isArray(data.connectors) ? data.connectors : []) {
    const c = sanitizeConnector(raw);
    if (!c) { summary.skipped += 1; continue; }
    const fromId = idMap.get(c.fromId) || c.fromId;
    const toId = idMap.get(c.toId) || c.toId;
    if (!objIds.has(fromId) || !objIds.has(toId) || fromId === toId) { summary.skipped += 1; continue; }
    let id = c.id;
    if (connTaken.has(id)) id = genId('conn');
    connTaken.add(id);
    room.connectors.push({ ...c, id, fromId, toId });
    summary.connectors += 1;
  }
  // Chat: union by id, keep order by time.
  const incomingMsgs = normalizeMessages(pickRawMessages(data), room.id);
  const haveMsg = new Set(room.messages.map((m) => m.id));
  const addMsgs = incomingMsgs.filter((m) => !haveMsg.has(m.id));
  summary.messages = addMsgs.length;
  room.messages = normalizeMessages([...room.messages, ...addMsgs], room.id);
  // Kanban: add columns/cards that are missing (by id).
  if (Array.isArray(data.columns)) {
    const haveCol = new Set(room.columns.map((c) => c.id));
    for (const col of data.columns) {
      if (isPlainObject(col) && col.id && !haveCol.has(col.id)) {
        room.columns.push({ id: String(col.id), title: String(col.title || 'Колонка').slice(0, 64), order: finiteOr(col.order, room.columns.length) });
        haveCol.add(col.id);
      }
    }
  }
  if (Array.isArray(data.cards)) {
    const haveCard = new Set(room.cards.map((c) => c.id));
    const colIds = new Set(room.columns.map((c) => c.id));
    for (const card of data.cards) {
      if (!isPlainObject(card) || (card.id && haveCard.has(card.id))) continue;
      const norm = normalizeCard(card, room, colIds.has(card.columnId) ? card.columnId : room.columns[0]?.id);
      room.cards.push(norm);
      haveCard.add(norm.id);
      summary.cards += 1;
    }
  }
  return summary;
}

// ---------- Socket auth ----------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const user = verifyToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.account = publicUser(user);
  next();
});

io.on('connection', (socket) => {
  // Never let one bad payload crash the whole server: wrap every handler.
  {
    const rawOn = socket.on.bind(socket);
    socket.on = (event, handler) => rawOn(event, (...args) => {
      try {
        return handler(...args);
      } catch (err) {
        console.error(`socket handler "${event}" failed:`, err);
        const ack = args[args.length - 1];
        if (typeof ack === 'function') {
          try { ack({ ok: false, error: 'Ошибка сервера' }); } catch { /* ignore */ }
        }
        return undefined;
      }
    });
  }
  let currentRoom = null;
  let userId = null; // presence id in room (= socket.id)
  const account = socket.account;

  markOnline(account.id, socket.id);
  broadcastPresence();

  socket.emit('auth-ok', {
    user: account,
    totalUnread: totalUnread(account.id),
  });

  socket.emit('personal-kanban-state', personalBoardPublic(account.id));

  function leaveCurrent() {
    if (!currentRoom || !userId) return;
    const room = rooms.get(currentRoom);
    const rid = currentRoom;
    if (room) {
      room.users.delete(userId);
      socket.to(rid).emit('user-left', { id: userId });
      // Keep durable room data (memory + disk). Only presence is ephemeral.
      if (room.users.size === 0) scheduleRoomSave(rid, { immediate: true });
    }
    socket.leave(rid);
    currentRoom = null;
  }

  socket.on('join-room', ({ roomId, visibility, create, title } = {}, ack) => {
    try {
      if (!roomId || typeof roomId !== 'string') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Неверный код комнаты' });
        return;
      }
      const id = normalizeRoomId(roomId);
      if (!id) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Неверный код комнаты' });
        return;
      }
      const displayName = (account.displayName || account.username).slice(0, 32);
      if (rooms.has(id)) maybeReloadRoomFromDisk(id);
      const exists = rooms.has(id);
      const wantPrivate = visibility === 'private';
      if (!exists && (create || wantPrivate || visibility === 'public')) {
        getOrCreateRoom(id, {
          ownerId: account.id,
          visibility: wantPrivate ? 'private' : 'public',
          title: title || '',
        });
      }
      const room = getOrCreateRoom(id, { ownerId: account.id, visibility: 'public' });
      // First joiner becomes owner if missing
      let metaChanged = false;
      if (!room.ownerId) { room.ownerId = account.id; metaChanged = true; }
      if (!room.visibility) { room.visibility = 'public'; metaChanged = true; }
      if (metaChanged) scheduleRoomSave(room);

      if (!canAccessRoom(room, account.id)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Приватная комната: доступ только у владельца' });
        return;
      }

      if (currentRoom && currentRoom !== id) leaveCurrent();

      currentRoom = id;
      userId = socket.id;
      const color = pickColor(room);
      room.users.set(userId, {
        id: userId,
        accountId: account.id,
        name: displayName,
        color,
        cursor: null,
      });
      socket.join(id);

      if (typeof ack === 'function') {
        ack({
          ok: true,
          userId,
          accountId: account.id,
          color,
          name: displayName,
          roomId: id,
          state: roomPublicState(room),
          isOwner: room.ownerId === account.id,
          myRole: getMemberRole(room, account.id),
        });
      }
      socket.to(id).emit('user-joined', {
        id: userId,
        accountId: account.id,
        name: displayName,
        color,
        cursor: null,
      });
      io.emit('public-rooms', listPublicRooms());
    } catch (err) {
      console.error('join-room error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Ошибка сервера' });
    }
  });

  socket.on('list-public-rooms', (ack) => {
    if (typeof ack === 'function') ack({ ok: true, rooms: listPublicRooms() });
  });

  socket.on('delete-room', ({ roomId } = {}, ack) => {
    try {
      const id = normalizeRoomId(roomId || currentRoom);
      if (!id) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Неверный код комнаты' });
        return;
      }
      const room = rooms.get(id);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Комната не найдена' });
        return;
      }
      const isOwner = room.ownerId === account.id;
      const admin = isAppAdmin(account);
      const isPublic = (room.visibility || 'public') !== 'private';
      if (isPublic) {
        if (!admin) {
          if (typeof ack === 'function') ack({ ok: false, error: 'Открытую комнату может удалить только администратор приложения' });
          return;
        }
      } else if (!isOwner && !admin) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Удалить может только владелец' });
        return;
      }
      io.to(id).emit('room-deleted', { roomId: id });
      for (const sid of Array.from(room.users.keys())) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          try { sock.leave(id); } catch { /* ignore */ }
        }
      }
      rooms.delete(id);
      deleteRoomFromDisk(id);
      if (currentRoom === id) {
        currentRoom = null;
        userId = null;
      }
      io.emit('public-rooms', listPublicRooms());
      if (typeof ack === 'function') ack({ ok: true, roomId: id });
    } catch (err) {
      console.error('delete-room', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Ошибка сервера' });
    }
  });


  socket.on('room-invite', ({ roomId, username, role } = {}, ack) => {
    try {
      const id = normalizeRoomId(roomId || currentRoom);
      const room = rooms.get(id);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Комната не найдена' });
        return;
      }
      const myRole = getMemberRole(room, account.id);
      if (myRole !== 'owner' && myRole !== 'admin') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Приглашать может владелец или админ' });
        return;
      }
      const un = String(username || '').trim().toLowerCase();
      const other = findUserByUsername(un);
      if (!other) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Пользователь не найден' });
        return;
      }
      if (other.id === room.ownerId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Это владелец комнаты' });
        return;
      }
      if (!Array.isArray(room.members)) room.members = [];
      const existing = room.members.find((m) => m.userId === other.id);
      const r = role === 'editor' || role === 'admin' ? role : 'member';
      if (existing) existing.role = r;
      else room.members.push({ userId: other.id, role: r });
      scheduleRoomSave(id);
      io.to(id).emit('room-members', { roomId: id, members: membersPublic(room) });
      emitToAccount(other.id, 'room-invite-notice', {
        roomId: id,
        title: room.title || id,
        fromName: account.displayName || account.username,
        role: r,
      });
      if (typeof ack === 'function') ack({ ok: true, members: membersPublic(room) });
    } catch (err) {
      console.error('room-invite', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Ошибка сервера' });
    }
  });

  socket.on('room-set-role', ({ roomId, userId, role } = {}, ack) => {
    try {
      const id = normalizeRoomId(roomId || currentRoom);
      const room = rooms.get(id);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Комната не найдена' });
        return;
      }
      if (getMemberRole(room, account.id) !== 'owner') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Только владелец меняет роли' });
        return;
      }
      if (!userId || userId === room.ownerId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Нельзя изменить владельца' });
        return;
      }
      if (!Array.isArray(room.members)) room.members = [];
      const m = room.members.find((x) => x.userId === userId);
      if (!m) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Участник не найден' });
        return;
      }
      m.role = role === 'editor' || role === 'admin' ? role : 'member';
      scheduleRoomSave(id);
      io.to(id).emit('room-members', { roomId: id, members: membersPublic(room) });
      if (typeof ack === 'function') ack({ ok: true, members: membersPublic(room) });
    } catch (err) {
      console.error('room-set-role', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Ошибка сервера' });
    }
  });

  socket.on('room-remove-member', ({ roomId, userId } = {}, ack) => {
    try {
      const id = normalizeRoomId(roomId || currentRoom);
      const room = rooms.get(id);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Комната не найдена' });
        return;
      }
      if (getMemberRole(room, account.id) !== 'owner') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Только владелец удаляет участников' });
        return;
      }
      if (!userId || userId === room.ownerId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Нельзя удалить владельца' });
        return;
      }
      room.members = (room.members || []).filter((m) => m.userId !== userId);
      scheduleRoomSave(id);
      io.to(id).emit('room-members', { roomId: id, members: membersPublic(room) });
      // kick if online in room
      for (const [sid, u] of room.users.entries()) {
        if (u.accountId === userId) {
          const sock = io.sockets.sockets.get(sid);
          if (sock) {
            sock.emit('room-kicked', { roomId: id, reason: 'Вас удалили из комнаты' });
            try { sock.leave(id); } catch { /* ignore */ }
          }
          room.users.delete(sid);
        }
      }
      if (typeof ack === 'function') ack({ ok: true, members: membersPublic(room) });
    } catch (err) {
      console.error('room-remove-member', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Ошибка сервера' });
    }
  });

  socket.on('leave-room', () => {
    leaveCurrent();
  });

  socket.on('cursor-move', (payload) => {
    if (!currentRoom || !userId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(userId);
    if (!user) return;
    user.cursor = payload && typeof payload.x === 'number'
      ? { x: payload.x, y: payload.y }
      : null;
    socket.to(currentRoom).emit('cursor-move', { id: userId, cursor: user.cursor });
  });

  socket.on('room-snapshot', ({ roomId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const id = normalizeRoomId(roomId);
      if (!id) {
        ack({ ok: false, error: 'Неверный код комнаты' });
        return;
      }
      const room = rooms.get(id);
      if (!room) {
        ack({ ok: false, error: 'Комната не найдена' });
        return;
      }
      if (!canAccessRoom(room, account.id)) {
        ack({ ok: false, error: 'Приватная комната' });
        return;
      }
      ack({
        ok: true,
        roomId: id,
        objects: JSON.parse(JSON.stringify(room.objects || [])),
        connectors: JSON.parse(JSON.stringify(room.connectors || [])),
      });
    } catch (err) {
      ack({ ok: false, error: (err && err.message) || 'Ошибка снимка комнаты' });
    }
  });

  socket.on('object-add', (obj) => {
    if (!currentRoom || !obj || !obj.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const idx = room.objects.findIndex((o) => o.id === obj.id);
    if (idx >= 0) room.objects[idx] = obj; // re-add (undo/redo) must not duplicate
    else room.objects.push(obj);
    scheduleRoomSave(currentRoom);
    socket.to(currentRoom).emit('object-add', obj);
  });

  // Z-order: full list of object ids in back-to-front order.
  socket.on('objects-reorder', ({ ids } = {}) => {
    if (!currentRoom || !Array.isArray(ids)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const pos = new Map();
    ids.forEach((id, i) => { if (typeof id === 'string' && !pos.has(id)) pos.set(id, i); });
    const known = room.objects.filter((o) => pos.has(o.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const unknown = room.objects.filter((o) => !pos.has(o.id));
    room.objects = [...known, ...unknown];
    scheduleRoomSave(currentRoom);
    socket.to(currentRoom).emit('objects-reorder', { ids: room.objects.map((o) => o.id) });
  });

  // Room import (from an exported JSON). mode: 'merge' (add) | 'replace' (canvas only).
  // Chat messages and kanban cards are always merged, never wiped.
  socket.on('room-import', ({ data, mode } = {}, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    if (!currentRoom) return reply({ ok: false, error: 'Нет активной комнаты' });
    const room = rooms.get(currentRoom);
    if (!room) return reply({ ok: false, error: 'Комната не найдена' });
    if (!isPlainObject(data)) return reply({ ok: false, error: 'Файл не похож на экспорт комнаты' });
    const summary = importIntoRoom(room, data, mode === 'replace' ? 'replace' : 'merge');
    scheduleRoomSave(currentRoom, { immediate: true });
    io.to(currentRoom).emit('room-state', {
      roomId: currentRoom,
      objects: room.objects,
      connectors: room.connectors,
      columns: room.columns,
      cards: room.cards,
      messages: room.messages,
    });
    reply({ ok: true, summary });
  });

  socket.on('object-update', (obj) => {
    if (!currentRoom || !obj || !obj.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const idx = room.objects.findIndex((o) => o.id === obj.id);
    if (idx >= 0) {
      room.objects[idx] = { ...room.objects[idx], ...obj };
      scheduleRoomSave(currentRoom);
      socket.to(currentRoom).emit('object-update', room.objects[idx]);
    }
  });

  socket.on('object-delete', ({ ids }) => {
    if (!currentRoom || !Array.isArray(ids)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const set = new Set(ids);
    room.objects = room.objects.filter((o) => !set.has(o.id));
    const removedConnectors = room.connectors.filter(
      (c) => set.has(c.fromId) || set.has(c.toId) || set.has(c.id)
    );
    room.connectors = room.connectors.filter(
      (c) => !set.has(c.fromId) && !set.has(c.toId) && !set.has(c.id)
    );
    scheduleRoomSave(currentRoom);
    socket.to(currentRoom).emit('object-delete', { ids });
    if (removedConnectors.length) {
      const connIds = removedConnectors.map((c) => c.id);
      io.to(currentRoom).emit('connector-delete', { ids: connIds });
    }
  });

  socket.on('connector-add', (conn) => {
    if (!currentRoom || !conn || !conn.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (!conn.fromId || !conn.toId || conn.fromId === conn.toId) return;
    if (room.connectors.some((c) => c.id === conn.id)) return;
    const item = {
      id: conn.id,
      type: 'connector',
      fromId: conn.fromId,
      toId: conn.toId,
      stroke: conn.stroke || '#64748b',
      strokeWidth: conn.strokeWidth || 2,
      arrow: conn.arrow !== false,
      heads: conn.heads || (conn.arrow === false ? 'none' : 'end'),
      dash: conn.dash || 'solid',
    };
    room.connectors.push(item);
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('connector-add', item);
  });

  socket.on('connector-update', (conn) => {
    if (!currentRoom || !conn || !conn.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const idx = room.connectors.findIndex((c) => c.id === conn.id);
    if (idx < 0) return;
    room.connectors[idx] = { ...room.connectors[idx], ...conn };
    scheduleRoomSave(currentRoom);
    socket.to(currentRoom).emit('connector-update', room.connectors[idx]);
  });

  socket.on('connector-delete', ({ ids }) => {
    if (!currentRoom || !Array.isArray(ids)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const set = new Set(ids);
    room.connectors = room.connectors.filter((c) => !set.has(c.id));
    scheduleRoomSave(currentRoom);
    socket.to(currentRoom).emit('connector-delete', { ids });
  });

  socket.on('card-add', (card, ack) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const newCard = normalizeCard(card, room, card.columnId);
    room.cards.push(newCard);
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('card-add', newCard);
    if (typeof ack === 'function') ack({ ok: true, card: newCard });
  });

  socket.on('card-update', (card) => {
    if (!currentRoom || !card || !card.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const idx = room.cards.findIndex((c) => c.id === card.id);
    if (idx < 0) return;
    const prev = room.cards[idx];
    room.cards[idx] = {
      ...prev,
      title: card.title !== undefined ? String(card.title).slice(0, 200) : prev.title,
      description: card.description !== undefined ? String(card.description).slice(0, 2000) : prev.description,
      dueDate: card.dueDate !== undefined
        ? (card.dueDate ? String(card.dueDate).slice(0, 32) : null)
        : prev.dueDate,
      linkedRoomId: card.linkedRoomId !== undefined
        ? (card.linkedRoomId ? normalizeRoomId(card.linkedRoomId) : null)
        : (prev.linkedRoomId || null),
      columnId: card.columnId !== undefined ? card.columnId : prev.columnId,
      order: card.order !== undefined ? card.order : prev.order,
    };
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('card-update', room.cards[idx]);
  });

  socket.on('card-delete', ({ id }) => {
    if (!currentRoom || !id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.cards = room.cards.filter((c) => c.id !== id);
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('card-delete', { id });
  });

  socket.on('cards-reorder', ({ cards }) => {
    if (!currentRoom || !Array.isArray(cards)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const byId = new Map(room.cards.map((c) => [c.id, c]));
    for (const patch of cards) {
      const c = byId.get(patch.id);
      if (c) {
        if (patch.columnId !== undefined) c.columnId = patch.columnId;
        if (patch.order !== undefined) c.order = patch.order;
      }
    }
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('cards-reorder', { cards: room.cards });
  });

  socket.on('column-add', (payload, ack) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const order = room.columns.length
      ? Math.max(...room.columns.map((c) => c.order)) + 1
      : 0;
    const col = {
      id: (payload && payload.id) || genId('col'),
      title: String((payload && payload.title) || 'Новая колонка').slice(0, 64),
      order: typeof payload?.order === 'number' ? payload.order : order,
    };
    room.columns.push(col);
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('column-add', col);
    if (typeof ack === 'function') ack({ ok: true, column: col });
  });

  socket.on('column-rename', ({ id, title }) => {
    if (!currentRoom || !id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const col = room.columns.find((c) => c.id === id);
    if (!col) return;
    col.title = String(title || col.title).slice(0, 64);
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('column-rename', { id, title: col.title });
  });

  socket.on('column-delete', ({ id }) => {
    if (!currentRoom || !id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.columns.length <= 1) return;
    room.columns = room.columns.filter((c) => c.id !== id);
    const fallback = room.columns[0].id;
    for (const card of room.cards) {
      if (card.columnId === id) card.columnId = fallback;
    }
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('column-delete', { id, fallbackColumnId: fallback, cards: room.cards });
  });

  socket.on('chat-message', ({ text }, ack) => {
    if (!currentRoom || !userId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(userId);
    if (!user) return;
    const msgText = String(text || '').trim().slice(0, 1000);
    if (!msgText) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Пустое сообщение' });
      return;
    }
    const message = {
      id: genId('msg'),
      userId: user.id,
      accountId: account.id,
      name: user.name,
      color: user.color,
      text: msgText,
      ts: Date.now(),
      roomId: currentRoom,
    };
    room.messages.push(message);
    if (room.messages.length > MAX_CHAT) {
      room.messages = room.messages.slice(-MAX_CHAT);
    }
    scheduleRoomSave(currentRoom);
    io.to(currentRoom).emit('chat-message', message);
    if (typeof ack === 'function') ack({ ok: true, message });
  });

  // ---------- Personal Kanban (private per account) ----------
  function emitPersonalState() {
    emitToAccount(account.id, 'personal-kanban-state', personalBoardPublic(account.id));
  }

  socket.on('personal-kanban-get', (ack) => {
    const state = personalBoardPublic(account.id);
    if (typeof ack === 'function') ack({ ok: true, ...state });
    else socket.emit('personal-kanban-state', state);
  });

  socket.on('personal-card-add', (card, ack) => {
    const board = getPersonalBoard(account.id);
    const newCard = normalizeBoardCard(card || {}, board, card && card.columnId);
    board.cards.push(newCard);
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-card-add', newCard);
    if (typeof ack === 'function') ack({ ok: true, card: newCard });
  });

  socket.on('personal-card-update', (card) => {
    if (!card || !card.id) return;
    const board = getPersonalBoard(account.id);
    const idx = board.cards.findIndex((c) => c.id === card.id);
    if (idx < 0) return;
    const prev = board.cards[idx];
    board.cards[idx] = {
      ...prev,
      title: card.title !== undefined ? String(card.title).slice(0, 200) : prev.title,
      description: card.description !== undefined ? String(card.description).slice(0, 2000) : prev.description,
      dueDate: card.dueDate !== undefined
        ? (card.dueDate ? String(card.dueDate).slice(0, 32) : null)
        : prev.dueDate,
      linkedRoomId: card.linkedRoomId !== undefined
        ? (card.linkedRoomId ? normalizeRoomId(card.linkedRoomId) : null)
        : (prev.linkedRoomId || null),
      columnId: card.columnId !== undefined ? card.columnId : prev.columnId,
      order: card.order !== undefined ? card.order : prev.order,
    };
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-card-update', board.cards[idx]);
  });

  socket.on('personal-card-delete', ({ id }) => {
    if (!id) return;
    const board = getPersonalBoard(account.id);
    board.cards = board.cards.filter((c) => c.id !== id);
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-card-delete', { id });
  });

  socket.on('personal-cards-reorder', ({ cards }) => {
    if (!Array.isArray(cards)) return;
    const board = getPersonalBoard(account.id);
    const byId = new Map(board.cards.map((c) => [c.id, c]));
    for (const patch of cards) {
      const c = byId.get(patch.id);
      if (c) {
        if (patch.columnId !== undefined) c.columnId = patch.columnId;
        if (patch.order !== undefined) c.order = patch.order;
      }
    }
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-cards-reorder', { cards: board.cards });
  });

  socket.on('personal-column-add', (payload, ack) => {
    const board = getPersonalBoard(account.id);
    const order = board.columns.length
      ? Math.max(...board.columns.map((c) => c.order)) + 1
      : 0;
    const col = {
      id: (payload && payload.id) || genId('col'),
      title: String((payload && payload.title) || 'Новая колонка').slice(0, 64),
      order: typeof payload?.order === 'number' ? payload.order : order,
    };
    board.columns.push(col);
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-column-add', col);
    if (typeof ack === 'function') ack({ ok: true, column: col });
  });

  socket.on('personal-column-update', ({ id, title }) => {
    if (!id) return;
    const board = getPersonalBoard(account.id);
    const col = board.columns.find((c) => c.id === id);
    if (!col) return;
    col.title = String(title || col.title).slice(0, 64);
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-column-update', { id, title: col.title });
  });

  socket.on('personal-column-rename', ({ id, title }) => {
    if (!id) return;
    const board = getPersonalBoard(account.id);
    const col = board.columns.find((c) => c.id === id);
    if (!col) return;
    col.title = String(title || col.title).slice(0, 64);
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-column-update', { id, title: col.title });
    emitToAccount(account.id, 'personal-column-rename', { id, title: col.title });
  });

  socket.on('personal-column-delete', ({ id }) => {
    if (!id) return;
    const board = getPersonalBoard(account.id);
    if (board.columns.length <= 1) return;
    board.columns = board.columns.filter((c) => c.id !== id);
    const fallback = board.columns[0].id;
    for (const card of board.cards) {
      if (card.columnId === id) card.columnId = fallback;
    }
    savePersonalKanbanStore();
    emitToAccount(account.id, 'personal-column-delete', {
      id,
      fallbackColumnId: fallback,
      cards: board.cards,
    });
  });

  // ---------- DMs ----------
  socket.on('dm-list-users', (ack) => {
    const list = usersStore.users
      .filter((u) => u.id !== account.id)
      .map((u) => ({
        ...publicUser(u),
        online: isOnline(u.id),
        unread: getUnreadFor(account.id, u.id),
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
    const self = {
      ...publicUser(findUserById(account.id) || account),
      online: true,
      unread: 0,
      isFavorites: true,
      displayName: 'Избранные',
      username: 'favorites',
    };
    if (typeof ack === 'function') {
      ack({ ok: true, users: [self, ...list], totalUnread: totalUnread(account.id), favoritesId: account.id });
    }
  });

  socket.on('dm-get-thread', ({ otherId }, ack) => {
    const other = findUserById(otherId);
    if (!other) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Пользователь не найден' });
      return;
    }
    const key = threadKey(account.id, other.id);
    const messages = dmsStore.threads[key] || [];
    if (typeof ack === 'function') {
      ack({ ok: true, messages, other: publicUser(other) });
    }
  });

  socket.on('dm-mark-read', ({ otherId }, ack) => {
    if (!otherId) return;
    setUnread(account.id, otherId, 0);
    saveDmsStore(dmsStore);
    if (typeof ack === 'function') {
      ack({ ok: true, totalUnread: totalUnread(account.id) });
    }
    socket.emit('dm-unread', {
      otherId,
      unread: 0,
      totalUnread: totalUnread(account.id),
    });
  });

  socket.on('dm-send', ({ toId, text }, ack) => {
    try {
      const other = findUserById(toId);
      if (!other) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Пользователь не найден' });
        return;
      }
      const isFavorites = other.id === account.id;
      const msgText = String(text || '').trim().slice(0, 1000);
      if (!msgText) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Пустое сообщение' });
        return;
      }
      const key = threadKey(account.id, other.id);
      if (!dmsStore.threads[key]) dmsStore.threads[key] = [];
      const message = {
        id: genId('dm'),
        fromId: account.id,
        toId: other.id,
        fromName: isFavorites ? 'Избранные' : (account.displayName || account.username),
        text: msgText,
        ts: Date.now(),
        favorites: isFavorites || undefined,
      };
      dmsStore.threads[key].push(message);
      if (dmsStore.threads[key].length > MAX_DM_THREAD) {
        dmsStore.threads[key] = dmsStore.threads[key].slice(-MAX_DM_THREAD);
      }
      if (!isFavorites) {
        bumpUnread(other.id, account.id);
      }
      saveDmsStore(dmsStore);

      socket.emit('dm-message', message);
      if (!isFavorites) {
        emitToAccount(other.id, 'dm-message', message);
        emitToAccount(other.id, 'dm-unread', {
          otherId: account.id,
          unread: getUnreadFor(other.id, account.id),
          totalUnread: totalUnread(other.id),
        });
      }

      if (typeof ack === 'function') ack({ ok: true, message });
    } catch (err) {
      console.error('dm-send', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Ошибка сервера' });
    }
  });

  socket.on('disconnect', () => {
    leaveCurrent();
    markOffline(socket.id);
    broadcastPresence();
  });
});

ensureDataDir();
loadAllRoomsFromDisk();

function shutdown(signal) {
  console.log(`Shutting down (${signal})… flushing rooms`);
  try { flushAllRoomSaves(); } catch (err) { console.error(err); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  // Log and keep serving instead of dropping every room's live state.
  console.error('uncaughtException', err);
  try { flushAllRoomSaves(); } catch { /* ignore */ }
});
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
  console.log(`Tarkventum listening on http://localhost:${PORT}`);
});
