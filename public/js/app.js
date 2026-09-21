(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function uid(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function randomRoomCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // ---------- State ----------
  const state = {
    socket: null,
    userId: null,
    userName: '',
    userColor: '#3b82f6',
    roomId: null,
    view: 'canvas',
    tool: 'select',
    strokeColor: '#1f2937',
    objects: [],
    selectedIds: new Set(),
    columns: [],
    cards: [],
    messages: [],
    users: new Map(),
    camera: { x: 0, y: 0, scale: 1 },
    drawing: null,
    dragging: null,
    panning: false,
    spaceDown: false,
    lastCursorSent: 0,
    editingCardId: null,
  };

  // ---------- DOM ----------
  const lobby = $('#lobby');
  const app = $('#app');
  const nameInput = $('#name-input');
  const roomInput = $('#room-input');
  const lobbyError = $('#lobby-error');
  const canvas = $('#board');
  const ctx = canvas.getContext('2d');
  const canvasWrap = $('#canvas-wrap');
  const cursorsEl = $('#cursors');
  const zoomLabel = $('#zoom-label');
  const presenceEl = $('#presence');
  const chatMessages = $('#chat-messages');
  const chatInput = $('#chat-input');
  const chatPanel = $('#chat-panel');
  const kanbanBoard = $('#kanban-board');

  // Prefill from path /r/:id and localStorage
  const pathMatch = location.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) roomInput.value = pathMatch[1];
  const savedName = localStorage.getItem('tv_name');
  if (savedName) nameInput.value = savedName;

  // ---------- Lobby ----------
  function showError(msg) {
    lobbyError.textContent = msg;
    lobbyError.classList.toggle('hidden', !msg);
  }

  function enterRoom(roomId) {
    const name = nameInput.value.trim() || 'Гость';
    localStorage.setItem('tv_name', name);
    showError('');
    if (!state.socket) {
      state.socket = io({ transports: ['websocket', 'polling'] });
      bindSocket(state.socket);
    }
    state.socket.emit('join-room', { roomId, name }, (res) => {
      if (!res || !res.ok) {
        showError((res && res.error) || 'Не удалось войти');
        return;
      }
      applyJoin(res);
    });
  }

  function applyJoin(res) {
    state.userId = res.userId;
    state.userName = res.name;
    state.userColor = res.color;
    state.roomId = res.roomId;
    const s = res.state || {};
    state.objects = s.objects || [];
    state.columns = s.columns || [];
    state.cards = s.cards || [];
    state.messages = s.messages || [];
    state.users = new Map((s.users || []).map((u) => [u.id, u]));
    state.selectedIds.clear();

    const url = `/r/${state.roomId}`;
    if (location.pathname !== url) history.replaceState(null, '', url);

    lobby.classList.add('hidden');
    app.classList.remove('hidden');
    $('#room-badge').textContent = state.roomId;
    renderPresence();
    renderChat();
    renderKanban();
    resizeCanvas();
    draw();
    setView(state.view);
  }

  $('#btn-create').addEventListener('click', () => {
    const code = roomInput.value.trim() || randomRoomCode();
    roomInput.value = code;
    enterRoom(code);
  });
  $('#btn-join').addEventListener('click', () => {
    const code = roomInput.value.trim();
    if (!code) return showError('Введите код комнаты');
    enterRoom(code);
  });
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join').click();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (roomInput.value.trim()) $('#btn-join').click();
      else $('#btn-create').click();
    }
  });

  $('#btn-leave').addEventListener('click', () => {
    location.href = '/';
  });

  $('#btn-copy-link').addEventListener('click', async () => {
    const link = `${location.origin}/r/${state.roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована');
    } catch {
      prompt('Скопируйте ссылку:', link);
    }
  });

  // ---------- Views ----------
  function setView(view) {
    state.view = view;
    $('#view-canvas').classList.toggle('hidden', view !== 'canvas');
    $('#view-kanban').classList.toggle('hidden', view !== 'kanban');
    $('#tab-canvas').classList.toggle('active', view === 'canvas');
    $('#tab-kanban').classList.toggle('active', view === 'kanban');
    if (view === 'canvas') {
      resizeCanvas();
      draw();
    }
  }
  $('#tab-canvas').addEventListener('click', () => setView('canvas'));
  $('#tab-kanban').addEventListener('click', () => setView('kanban'));

  // ---------- Tools ----------
  function setTool(tool) {
    state.tool = tool;
    $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvasWrap.style.cursor = tool === 'pan' || state.spaceDown ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
  }
  $$('.tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  $('#stroke-color').addEventListener('input', (e) => {
    state.strokeColor = e.target.value;
  });
  $('#btn-delete').addEventListener('click', deleteSelected);

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space') {
      state.spaceDown = true;
      canvasWrap.style.cursor = 'grab';
      e.preventDefault();
    }
    const map = { KeyV: 'select', KeyH: 'pan', KeyP: 'pen', KeyR: 'rect', KeyO: 'ellipse', KeyL: 'line', KeyA: 'arrow', KeyS: 'sticky', KeyT: 'text' };
    if (map[e.code] && !e.metaKey && !e.ctrlKey) setTool(map[e.code]);
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.view === 'canvas') {
      e.preventDefault();
      deleteSelected();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.spaceDown = false;
      setTool(state.tool);
    }
  });

  // ---------- Socket ----------
  function bindSocket(socket) {
    socket.on('user-joined', (u) => {
      state.users.set(u.id, u);
      renderPresence();
      renderCursors();
    });
    socket.on('user-left', ({ id }) => {
      state.users.delete(id);
      renderPresence();
      renderCursors();
    });
    socket.on('cursor-move', ({ id, cursor }) => {
      const u = state.users.get(id);
      if (u) {
        u.cursor = cursor;
        renderCursors();
      }
    });
    socket.on('object-add', (obj) => {
      if (!state.objects.find((o) => o.id === obj.id)) {
        state.objects.push(obj);
        draw();
      }
    });
    socket.on('object-update', (obj) => {
      const i = state.objects.findIndex((o) => o.id === obj.id);
      if (i >= 0) {
        state.objects[i] = obj;
        draw();
      }
    });
    socket.on('object-delete', ({ ids }) => {
      const set = new Set(ids);
      state.objects = state.objects.filter((o) => !set.has(o.id));
      ids.forEach((id) => state.selectedIds.delete(id));
      draw();
    });
    socket.on('card-add', (card) => {
      if (!state.cards.find((c) => c.id === card.id)) state.cards.push(card);
      renderKanban();
    });
    socket.on('card-update', (card) => {
      const i = state.cards.findIndex((c) => c.id === card.id);
      if (i >= 0) state.cards[i] = card;
      renderKanban();
    });
    socket.on('card-delete', ({ id }) => {
      state.cards = state.cards.filter((c) => c.id !== id);
      renderKanban();
    });
    socket.on('cards-reorder', ({ cards }) => {
      state.cards = cards;
      renderKanban();
    });
    socket.on('column-rename', ({ id, title }) => {
      const col = state.columns.find((c) => c.id === id);
      if (col) col.title = title;
      renderKanban();
    });
    socket.on('chat-message', (msg) => {
      if (!state.messages.find((m) => m.id === msg.id)) {
        state.messages.push(msg);
        if (state.messages.length > 100) state.messages = state.messages.slice(-100);
        appendChatMessage(msg, true);
      }
    });
    socket.on('disconnect', () => toast('Соединение потеряно…'));
    socket.on('connect', () => {
      if (state.roomId) {
        socket.emit('join-room', { roomId: state.roomId, name: state.userName }, (res) => {
          if (res && res.ok) applyJoin(res);
        });
      }
    });
  }

  function emit(event, data, ack) {
    if (state.socket) state.socket.emit(event, data, ack);
  }

  // ---------- Presence / cursors ----------
  function renderPresence() {
    presenceEl.innerHTML = '';
    for (const u of state.users.values()) {
      const d = document.createElement('div');
      d.className = 'presence-dot';
      d.style.background = u.color;
      d.title = u.name;
      d.textContent = (u.name || '?').slice(0, 1).toUpperCase();
      presenceEl.appendChild(d);
    }
  }

  function screenFromWorld(x, y) {
    const { camera } = state;
    return {
      x: (x + camera.x) * camera.scale,
      y: (y + camera.y) * camera.scale,
    };
  }

  function worldFromScreen(sx, sy) {
    const { camera } = state;
    return {
      x: sx / camera.scale - camera.x,
      y: sy / camera.scale - camera.y,
    };
  }

  function renderCursors() {
    cursorsEl.innerHTML = '';
    for (const u of state.users.values()) {
      if (u.id === state.userId || !u.cursor) continue;
      const p = screenFromWorld(u.cursor.x, u.cursor.y);
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.style.color = u.color;
      el.innerHTML = `<div class="pointer"></div><div class="label" style="background:${u.color}"><span>${escapeHtml(u.name)}</span></div>`;
      cursorsEl.appendChild(el);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- Canvas ----------
  function resizeCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function updateZoomLabel() {
    zoomLabel.textContent = `${Math.round(state.camera.scale * 100)}%`;
  }

  function drawObject(obj, selected) {
    ctx.save();
    ctx.lineWidth = obj.strokeWidth || 2;
    ctx.strokeStyle = obj.stroke || '#1f2937';
    ctx.fillStyle = obj.fill || 'transparent';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (obj.type === 'pen' && obj.points && obj.points.length) {
      ctx.beginPath();
      obj.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (obj.type === 'rect') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      const w = Math.abs(obj.w);
      const h = Math.abs(obj.h);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 6);
      if (obj.fill && obj.fill !== 'transparent') ctx.fill();
      ctx.stroke();
    } else if (obj.type === 'ellipse') {
      const cx = obj.x + obj.w / 2;
      const cy = obj.y + obj.h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(obj.w) / 2, Math.abs(obj.h) / 2, 0, 0, Math.PI * 2);
      if (obj.fill && obj.fill !== 'transparent') ctx.fill();
      ctx.stroke();
    } else if (obj.type === 'line' || obj.type === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(obj.x1, obj.y1);
      ctx.lineTo(obj.x2, obj.y2);
      ctx.stroke();
      if (obj.type === 'arrow') {
        const ang = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);
        const len = 12;
        ctx.beginPath();
        ctx.moveTo(obj.x2, obj.y2);
        ctx.lineTo(obj.x2 - len * Math.cos(ang - 0.4), obj.y2 - len * Math.sin(ang - 0.4));
        ctx.moveTo(obj.x2, obj.y2);
        ctx.lineTo(obj.x2 - len * Math.cos(ang + 0.4), obj.y2 - len * Math.sin(ang + 0.4));
        ctx.stroke();
      }
    } else if (obj.type === 'sticky') {
      const w = obj.w || 160;
      const h = obj.h || 120;
      ctx.fillStyle = obj.fill || '#fef08a';
      ctx.strokeStyle = 'rgba(0,0,0,.15)';
      ctx.beginPath();
      ctx.roundRect(obj.x, obj.y, w, h, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1f2937';
      ctx.font = '14px Segoe UI, system-ui, sans-serif';
      wrapText(ctx, obj.text || '', obj.x + 10, obj.y + 24, w - 20, 18);
    } else if (obj.type === 'text') {
      ctx.fillStyle = obj.stroke || '#e8eef7';
      ctx.font = `${obj.fontSize || 18}px Segoe UI, system-ui, sans-serif`;
      ctx.fillText(obj.text || '', obj.x, obj.y);
    }

    if (selected) {
      const b = boundsOf(obj);
      if (b) {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5 / state.camera.scale;
        ctx.setLineDash([6 / state.camera.scale, 4 / state.camera.scale]);
        ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  function wrapText(context, text, x, y, maxWidth, lineHeight) {
    const words = String(text).split(/\s+/);
    let line = '';
    let yy = y;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (context.measureText(test).width > maxWidth && line) {
        context.fillText(line, x, yy);
        line = word;
        yy += lineHeight;
      } else line = test;
    }
    if (line) context.fillText(line, x, yy);
  }

  function boundsOf(obj) {
    if (obj.type === 'pen' && obj.points && obj.points.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of obj.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (obj.type === 'rect' || obj.type === 'ellipse') {
      return {
        x: Math.min(obj.x, obj.x + obj.w),
        y: Math.min(obj.y, obj.y + obj.h),
        w: Math.abs(obj.w),
        h: Math.abs(obj.h),
      };
    }
    if (obj.type === 'line' || obj.type === 'arrow') {
      return {
        x: Math.min(obj.x1, obj.x2),
        y: Math.min(obj.y1, obj.y2),
        w: Math.abs(obj.x2 - obj.x1),
        h: Math.abs(obj.y2 - obj.y1),
      };
    }
    if (obj.type === 'sticky') return { x: obj.x, y: obj.y, w: obj.w || 160, h: obj.h || 120 };
    if (obj.type === 'text') {
      ctx.save();
      ctx.font = `${obj.fontSize || 18}px Segoe UI, system-ui, sans-serif`;
      const w = ctx.measureText(obj.text || '').width;
      ctx.restore();
      return { x: obj.x, y: obj.y - (obj.fontSize || 18), w, h: obj.fontSize || 18 };
    }
    return null;
  }

  function hitTest(wx, wy) {
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const obj = state.objects[i];
      const b = boundsOf(obj);
      if (!b) continue;
      const pad = 6 / state.camera.scale;
      if (wx >= b.x - pad && wx <= b.x + b.w + pad && wy >= b.y - pad && wy <= b.y + b.h + pad) {
        return obj;
      }
    }
    return null;
  }

  function draw() {
    const rect = canvasWrap.getBoundingClientRect();
    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.translate(state.camera.x * state.camera.scale, state.camera.y * state.camera.scale);
    ctx.scale(state.camera.scale, state.camera.scale);

    for (const obj of state.objects) {
      drawObject(obj, state.selectedIds.has(obj.id));
    }
    if (state.drawing) drawObject(state.drawing, false);
    ctx.restore();
    updateZoomLabel();
    renderCursors();
  }

  function getLocalPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function sendCursor(wx, wy) {
    const now = Date.now();
    if (now - state.lastCursorSent < 40) return;
    state.lastCursorSent = now;
    emit('cursor-move', { x: wx, y: wy });
  }

  function deleteSelected() {
    if (!state.selectedIds.size) return;
    const ids = [...state.selectedIds];
    state.objects = state.objects.filter((o) => !state.selectedIds.has(o.id));
    state.selectedIds.clear();
    emit('object-delete', { ids });
    draw();
  }

  function normalizeShape(obj) {
    if (obj.type === 'rect' || obj.type === 'ellipse') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      obj.w = Math.abs(obj.w);
      obj.h = Math.abs(obj.h);
      obj.x = x;
      obj.y = y;
    }
    return obj;
  }

  canvasWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pt = getLocalPoint(e);
    const before = worldFromScreen(pt.x, pt.y);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    state.camera.scale = Math.min(4, Math.max(0.2, state.camera.scale * factor));
    const after = worldFromScreen(pt.x, pt.y);
    state.camera.x += after.x - before.x;
    state.camera.y += after.y - before.y;
    draw();
  }, { passive: false });

  canvasWrap.addEventListener('pointerdown', (e) => {
    if (state.view !== 'canvas') return;
    canvasWrap.setPointerCapture(e.pointerId);
    const pt = getLocalPoint(e);
    const world = worldFromScreen(pt.x, pt.y);
    const middle = e.button === 1;
    const panMode = state.tool === 'pan' || state.spaceDown || middle;

    if (panMode) {
      state.panning = { sx: pt.x, sy: pt.y, cx: state.camera.x, cy: state.camera.y };
      canvasWrap.style.cursor = 'grabbing';
      return;
    }

    if (state.tool === 'select') {
      const hit = hitTest(world.x, world.y);
      if (hit) {
        if (!e.shiftKey) state.selectedIds.clear();
        state.selectedIds.add(hit.id);
        state.dragging = {
          ids: [...state.selectedIds],
          start: world,
          originals: Object.fromEntries(
            state.objects.filter((o) => state.selectedIds.has(o.id)).map((o) => [o.id, structuredClone(o)])
          ),
        };
      } else {
        state.selectedIds.clear();
      }
      draw();
      return;
    }

    if (state.tool === 'pen') {
      state.drawing = {
        id: uid('obj'),
        type: 'pen',
        stroke: state.strokeColor,
        strokeWidth: 2.5,
        points: [{ x: world.x, y: world.y }],
      };
      return;
    }

    if (state.tool === 'rect' || state.tool === 'ellipse') {
      state.drawing = {
        id: uid('obj'),
        type: state.tool,
        x: world.x,
        y: world.y,
        w: 0,
        h: 0,
        stroke: state.strokeColor,
        fill: 'transparent',
        strokeWidth: 2,
      };
      return;
    }

    if (state.tool === 'line' || state.tool === 'arrow') {
      state.drawing = {
        id: uid('obj'),
        type: state.tool,
        x1: world.x,
        y1: world.y,
        x2: world.x,
        y2: world.y,
        stroke: state.strokeColor,
        strokeWidth: 2,
      };
      return;
    }

    if (state.tool === 'sticky') {
      const text = prompt('Текст стикера:', 'Заметка');
      if (text === null) return;
      const obj = {
        id: uid('obj'),
        type: 'sticky',
        x: world.x,
        y: world.y,
        w: 160,
        h: 120,
        text: text.slice(0, 500),
        fill: '#fef08a',
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      draw();
      return;
    }

    if (state.tool === 'text') {
      const text = prompt('Текст:', '');
      if (text === null || !text.trim()) return;
      const obj = {
        id: uid('obj'),
        type: 'text',
        x: world.x,
        y: world.y,
        text: text.slice(0, 500),
        stroke: state.strokeColor,
        fontSize: 18,
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      draw();
    }
  });

  canvasWrap.addEventListener('pointermove', (e) => {
    const pt = getLocalPoint(e);
    const world = worldFromScreen(pt.x, pt.y);
    sendCursor(world.x, world.y);

    if (state.panning) {
      const dx = (pt.x - state.panning.sx) / state.camera.scale;
      const dy = (pt.y - state.panning.sy) / state.camera.scale;
      state.camera.x = state.panning.cx + dx;
      state.camera.y = state.panning.cy + dy;
      draw();
      return;
    }

    if (state.dragging) {
      const dx = world.x - state.dragging.start.x;
      const dy = world.y - state.dragging.start.y;
      for (const id of state.dragging.ids) {
        const orig = state.dragging.originals[id];
        const obj = state.objects.find((o) => o.id === id);
        if (!orig || !obj) continue;
        applyDelta(obj, orig, dx, dy);
        emit('object-update', obj);
      }
      draw();
      return;
    }

    if (state.drawing) {
      const d = state.drawing;
      if (d.type === 'pen') {
        d.points.push({ x: world.x, y: world.y });
      } else if (d.type === 'rect' || d.type === 'ellipse') {
        d.w = world.x - d.x;
        d.h = world.y - d.y;
      } else if (d.type === 'line' || d.type === 'arrow') {
        d.x2 = world.x;
        d.y2 = world.y;
      }
      draw();
    }
  });

  function applyDelta(obj, orig, dx, dy) {
    if (obj.type === 'pen') {
      obj.points = orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (obj.type === 'rect' || obj.type === 'ellipse' || obj.type === 'sticky' || obj.type === 'text') {
      obj.x = orig.x + dx;
      obj.y = orig.y + dy;
    } else if (obj.type === 'line' || obj.type === 'arrow') {
      obj.x1 = orig.x1 + dx;
      obj.y1 = orig.y1 + dy;
      obj.x2 = orig.x2 + dx;
      obj.y2 = orig.y2 + dy;
    }
  }

  canvasWrap.addEventListener('pointerup', (e) => {
    if (state.panning) {
      state.panning = false;
      setTool(state.tool);
    }
    if (state.dragging) {
      state.dragging = null;
    }
    if (state.drawing) {
      let obj = state.drawing;
      state.drawing = null;
      if (obj.type === 'pen' && (!obj.points || obj.points.length < 2)) return draw();
      if ((obj.type === 'rect' || obj.type === 'ellipse') && Math.abs(obj.w) < 2 && Math.abs(obj.h) < 2) return draw();
      obj = normalizeShape(obj);
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      draw();
    }
  });

  canvasWrap.addEventListener('pointerleave', () => {
    emit('cursor-move', null);
  });

  // ---------- Kanban ----------
  function cardsInColumn(colId) {
    return state.cards
      .filter((c) => c.columnId === colId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  function renderKanban() {
    kanbanBoard.innerHTML = '';
    const cols = [...state.columns].sort((a, b) => a.order - b.order);
    for (const col of cols) {
      const cards = cardsInColumn(col.id);
      const el = document.createElement('div');
      el.className = 'kanban-col';
      el.dataset.columnId = col.id;
      el.innerHTML = `
        <div class="kanban-col-head">
          <input class="kanban-col-title" value="${escapeHtml(col.title)}" data-col="${col.id}" />
          <span class="kanban-count">${cards.length}</span>
        </div>
        <div class="kanban-cards" data-column-id="${col.id}"></div>
        <button class="kanban-add" type="button" data-add="${col.id}">+ Добавить карточку</button>
      `;
      const list = $('.kanban-cards', el);
      for (const card of cards) {
        const cardEl = document.createElement('div');
        cardEl.className = 'kanban-card';
        cardEl.draggable = true;
        cardEl.dataset.cardId = card.id;
        cardEl.innerHTML = `<h4>${escapeHtml(card.title)}</h4>${card.description ? `<p>${escapeHtml(card.description)}</p>` : ''}`;
        cardEl.addEventListener('dragstart', (e) => {
          cardEl.classList.add('dragging');
          e.dataTransfer.setData('text/plain', card.id);
          e.dataTransfer.effectAllowed = 'move';
        });
        cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
        cardEl.addEventListener('click', (e) => {
          if (e.defaultPrevented) return;
          openCardModal(card.id);
        });
        list.appendChild(cardEl);
      }
      list.addEventListener('dragover', (e) => {
        e.preventDefault();
        list.classList.add('drag-over');
      });
      list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
      list.addEventListener('drop', (e) => {
        e.preventDefault();
        list.classList.remove('drag-over');
        const cardId = e.dataTransfer.getData('text/plain');
        moveCardToColumn(cardId, col.id);
      });
      kanbanBoard.appendChild(el);
    }

    $$('.kanban-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const columnId = btn.dataset.add;
        const title = prompt('Заголовок карточки:', 'Новая карточка');
        if (!title) return;
        emit('card-add', {
          columnId,
          title: title.trim(),
          description: '',
          order: cardsInColumn(columnId).length,
        });
      });
    });

    $$('.kanban-col-title').forEach((input) => {
      input.addEventListener('change', () => {
        emit('column-rename', { id: input.dataset.col, title: input.value.trim() || 'Колонка' });
      });
    });
  }

  function moveCardToColumn(cardId, columnId) {
    const card = state.cards.find((c) => c.id === cardId);
    if (!card) return;
    const order = cardsInColumn(columnId).filter((c) => c.id !== cardId).length;
    const patches = state.cards.map((c) => {
      if (c.id === cardId) return { id: c.id, columnId, order };
      return { id: c.id, columnId: c.columnId, order: c.order };
    });
    // optimistic
    card.columnId = columnId;
    card.order = order;
    emit('cards-reorder', { cards: patches.map((p) => (p.id === cardId ? { id: cardId, columnId, order } : p)) });
    // simpler: emit targeted update
    emit('card-update', { id: cardId, columnId, order });
    renderKanban();
  }

  function openCardModal(id) {
    const card = state.cards.find((c) => c.id === id);
    if (!card) return;
    state.editingCardId = id;
    $('#card-title').value = card.title;
    $('#card-desc').value = card.description || '';
    $('#modal-card').classList.remove('hidden');
  }

  $('#card-cancel-btn').addEventListener('click', () => {
    $('#modal-card').classList.add('hidden');
    state.editingCardId = null;
  });
  $('#card-save-btn').addEventListener('click', () => {
    if (!state.editingCardId) return;
    emit('card-update', {
      id: state.editingCardId,
      title: $('#card-title').value.trim() || 'Без названия',
      description: $('#card-desc').value,
    });
    $('#modal-card').classList.add('hidden');
    state.editingCardId = null;
  });
  $('#card-delete-btn').addEventListener('click', () => {
    if (!state.editingCardId) return;
    emit('card-delete', { id: state.editingCardId });
    $('#modal-card').classList.add('hidden');
    state.editingCardId = null;
  });

  // ---------- Chat ----------
  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function appendChatMessage(msg, scroll) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `
      <div class="chat-msg-meta">
        <span class="chat-msg-name" style="color:${msg.color || '#93c5fd'}">${escapeHtml(msg.name)}</span>
        <span class="chat-msg-time">${formatTime(msg.ts)}</span>
      </div>
      <div class="chat-msg-text">${escapeHtml(msg.text)}</div>
    `;
    chatMessages.appendChild(el);
    if (scroll) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function renderChat() {
    chatMessages.innerHTML = '';
    for (const msg of state.messages) appendChatMessage(msg, false);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    emit('chat-message', { text });
  });

  $('#btn-toggle-chat').addEventListener('click', () => {
    chatPanel.classList.toggle('collapsed');
    $('#btn-toggle-chat').textContent = chatPanel.classList.contains('collapsed') ? '▶' : '◀';
    resizeCanvas();
  });

  // Auto-join if path has room and name saved
  if (pathMatch && savedName) {
    // wait a tick for UI
    setTimeout(() => enterRoom(pathMatch[1]), 50);
  }
})();
