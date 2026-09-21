const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_CHAT = 100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/r/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/** @type {Map<string, object>} */
const rooms = new Map();

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

function createRoom(id) {
  return {
    id,
    objects: [],
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
    columns: room.columns,
    cards: room.cards,
    messages: room.messages,
    users: Array.from(room.users.values()).map((u) => ({
      id: u.id,
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

io.on('connection', (socket) => {
  let currentRoom = null;
  let userId = null;

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

  socket.on('join-room', ({ roomId, name }, ack) => {
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
      const displayName = (name && String(name).trim().slice(0, 32)) || 'Гость';
      const room = getOrCreateRoom(id);

      if (currentRoom && currentRoom !== id) leaveCurrent();

      currentRoom = id;
      userId = socket.id;
      const color = pickColor(room);
      room.users.set(userId, { id: userId, name: displayName, color, cursor: null });
      socket.join(id);

      if (typeof ack === 'function') {
        ack({
          ok: true,
          userId,
          color,
          name: displayName,
          roomId: id,
          state: roomPublicState(room),
        });
      }
      socket.to(id).emit('user-joined', {
        id: userId,
        name: displayName,
        color,
        cursor: null,
      });
    } catch (err) {
      console.error('join-room error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Ошибка сервера' });
    }
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
    socket.to(currentRoom).emit('object-delete', { ids });
  });

  socket.on('card-add', (card, ack) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const newCard = {
      id: card.id || genId('card'),
      columnId: card.columnId || room.columns[0].id,
      title: (card.title || 'Новая карточка').slice(0, 200),
      description: (card.description || '').slice(0, 2000),
      order: typeof card.order === 'number' ? card.order : room.cards.filter((c) => c.columnId === (card.columnId || room.columns[0].id)).length,
    };
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

  socket.on('column-rename', ({ id, title }) => {
    if (!currentRoom || !id) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const col = room.columns.find((c) => c.id === id);
    if (!col) return;
    col.title = String(title || col.title).slice(0, 64);
    io.to(currentRoom).emit('column-rename', { id, title: col.title });
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
      name: user.name,
      color: user.color,
      text: msgText,
      ts: Date.now(),
    };
    room.messages.push(message);
    if (room.messages.length > MAX_CHAT) {
      room.messages = room.messages.slice(-MAX_CHAT);
    }
    io.to(currentRoom).emit('chat-message', message);
    if (typeof ack === 'function') ack({ ok: true, message });
  });

  socket.on('disconnect', () => {
    leaveCurrent();
  });
});

server.listen(PORT, () => {
  console.log(`Tarkventum listening on http://localhost:${PORT}`);
});
