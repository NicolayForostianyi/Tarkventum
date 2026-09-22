const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const MAX_CHAT = 100;
const MAX_DM_THREAD = 500;
const JWT_SECRET = process.env.JWT_SECRET || 'tarkventum-dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d';
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');
const PERSONAL_KANBAN_FILE = path.join(DATA_DIR, 'personal-kanban.json');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MAX_AVATAR_BYTES = 800 * 1024;
const MAX_CANVAS_IMAGE_BYTES = 3 * 1024 * 1024;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

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
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('loadJson', file, err.message);
    return fallback;
  }
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
function createRoom(id) {
  return {
    id,
    objects: [],
    connectors: [],
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    cards: [],
    messages: [],
    users: new Map(),
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
  return rooms.get(roomId);
}

function roomPublicState(room) {
  return {
    objects: room.objects,
    connectors: room.connectors,
    columns: room.columns,
    cards: room.cards,
    messages: room.messages,
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
    order: typeof card.order === 'number'
      ? card.order
      : room.cards.filter((c) => c.columnId === columnId).length,
  };
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
      setTimeout(() => {
        const r = rooms.get(rid);
        if (r && r.users.size === 0) rooms.delete(rid);
      }, 5 * 60 * 1000);
    }
    socket.leave(rid);
    currentRoom = null;
  }

  socket.on('join-room', ({ roomId }, ack) => {
    try {
      if (!roomId || typeof roomId !== 'string') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Неверный код комнаты' });
        return;
      }
      const id = roomId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
      if (!id) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Неверный код комнаты' });
        return;
      }
      const displayName = (account.displayName || account.username).slice(0, 32);
      const room = getOrCreateRoom(id);

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
        });
      }
      socket.to(id).emit('user-joined', {
        id: userId,
        accountId: account.id,
        name: displayName,
        color,
        cursor: null,
      });
    } catch (err) {
      console.error('join-room error', err);
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

  socket.on('object-add', (obj) => {
    if (!currentRoom || !obj || !obj.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.objects.push(obj);
    socket.to(currentRoom).emit('object-add', obj);
  });

  socket.on('object-update', (obj) => {
    if (!currentRoom || !obj || !obj.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const idx = room.objects.findIndex((o) => o.id === obj.id);
    if (idx >= 0) {
      room.objects[idx] = { ...room.objects[idx], ...obj };
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
    };
    room.connectors.push(item);
    io.to(currentRoom).emit('connector-add', item);
  });

  socket.on('connector-update', (conn) => {
    if (!currentRoom || !conn || !conn.id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const idx = room.connectors.findIndex((c) => c.id === conn.id);
    if (idx < 0) return;
    room.connectors[idx] = { ...room.connectors[idx], ...conn };
    socket.to(currentRoom).emit('connector-update', room.connectors[idx]);
  });

  socket.on('connector-delete', ({ ids }) => {
    if (!currentRoom || !Array.isArray(ids)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const set = new Set(ids);
    room.connectors = room.connectors.filter((c) => !set.has(c.id));
    socket.to(currentRoom).emit('connector-delete', { ids });
  });

  socket.on('card-add', (card, ack) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const newCard = normalizeCard(card, room, card.columnId);
    room.cards.push(newCard);
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
      columnId: card.columnId !== undefined ? card.columnId : prev.columnId,
      order: card.order !== undefined ? card.order : prev.order,
    };
    io.to(currentRoom).emit('card-update', room.cards[idx]);
  });

  socket.on('card-delete', ({ id }) => {
    if (!currentRoom || !id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.cards = room.cards.filter((c) => c.id !== id);
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
    if (typeof ack === 'function') {
      ack({ ok: true, users: list, totalUnread: totalUnread(account.id) });
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
      if (other.id === account.id) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Нельзя писать себе' });
        return;
      }
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
        fromName: account.displayName || account.username,
        text: msgText,
        ts: Date.now(),
      };
      dmsStore.threads[key].push(message);
      if (dmsStore.threads[key].length > MAX_DM_THREAD) {
        dmsStore.threads[key] = dmsStore.threads[key].slice(-MAX_DM_THREAD);
      }
      bumpUnread(other.id, account.id);
      saveDmsStore(dmsStore);

      socket.emit('dm-message', message);
      emitToAccount(other.id, 'dm-message', message);
      emitToAccount(other.id, 'dm-unread', {
        otherId: account.id,
        unread: getUnreadFor(other.id, account.id),
        totalUnread: totalUnread(other.id),
      });

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

server.listen(PORT, () => {
  console.log(`Tarkventum listening on http://localhost:${PORT}`);
});
