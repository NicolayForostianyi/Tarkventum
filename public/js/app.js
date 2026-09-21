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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- Themes ----------
  const THEMES = ['black', 'white', 'green', 'blue'];
  function applyTheme(name) {
    const theme = THEMES.includes(name) ? name : 'black';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tv_theme', theme);
    const a = $('#theme-select');
    const b = $('#theme-select-lobby');
    if (a) a.value = theme;
    if (b) b.value = theme;
    if (typeof draw === 'function') draw();
  }
  applyTheme(localStorage.getItem('tv_theme') || 'black');

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
    connectors: [],
    selectedIds: new Set(),
    selectedConnectorIds: new Set(),
    hoverId: null,
    hoverConnectorId: null,
    columns: [],
    cards: [],
    messages: [],
    users: new Map(),
    camera: { x: 0, y: 0, scale: 1 },
    drawing: null,
    dragging: null,
    resizing: null,
    panning: false,
    spaceDown: false,
    lastCursorSent: 0,
    editingCardId: null,
    connectorFromId: null,
    inlineEdit: null,
    tabs: [], // { roomId }
    joining: false,
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
  const inlineEditEl = $('#inline-edit');
  const connectorHint = $('#connector-hint');
  const cardPanel = $('#card-panel');
  const roomTabsEl = $('#room-tabs');

  const pathMatch = location.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) roomInput.value = pathMatch[1];
  const savedName = localStorage.getItem('tv_name');
  if (savedName) nameInput.value = savedName;

  nameInput.addEventListener('change', () => {
    const n = nameInput.value.trim();
    if (n) localStorage.setItem('tv_name', n);
  });
  nameInput.addEventListener('blur', () => {
    const n = nameInput.value.trim();
    if (n) localStorage.setItem('tv_name', n);
  });

  $('#theme-select').addEventListener('change', (e) => applyTheme(e.target.value));
  $('#theme-select-lobby').addEventListener('change', (e) => applyTheme(e.target.value));

  // ---------- Lobby ----------
  function showError(msg) {
    lobbyError.textContent = msg;
    lobbyError.classList.toggle('hidden', !msg);
  }

  function ensureSocket() {
    if (!state.socket) {
      state.socket = io({ transports: ['websocket', 'polling'] });
      bindSocket(state.socket);
    }
    return state.socket;
  }

  function enterRoom(roomId, { addTab = true } = {}) {
    const name = (nameInput.value.trim() || localStorage.getItem('tv_name') || 'Гость').slice(0, 32);
    nameInput.value = name;
    localStorage.setItem('tv_name', name);
    state.userName = name;
    showError('');
    const socket = ensureSocket();
    state.joining = true;
    cancelInlineEdit(true);
    socket.emit('join-room', { roomId, name }, (res) => {
      state.joining = false;
      if (!res || !res.ok) {
        showError((res && res.error) || 'Не удалось войти');
        toast((res && res.error) || 'Не удалось войти');
        return;
      }
      if (addTab) upsertTab(res.roomId);
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
    state.connectors = s.connectors || [];
    state.columns = s.columns || [];
    state.cards = (s.cards || []).map((c) => ({ dueDate: null, ...c }));
    state.messages = s.messages || [];
    state.users = new Map((s.users || []).map((u) => [u.id, u]));
    state.selectedIds.clear();
    state.selectedConnectorIds.clear();
    state.hoverId = null;
    state.connectorFromId = null;
    connectorHint.classList.add('hidden');
    closeCardPanel();

    const url = `/r/${state.roomId}`;
    if (location.pathname !== url) history.replaceState(null, '', url);

    lobby.classList.add('hidden');
    app.classList.remove('hidden');
    $('#room-badge').textContent = state.roomId;
    renderTabs();
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
    if (state.socket) state.socket.emit('leave-room');
    state.roomId = null;
    state.tabs = [];
    localStorage.removeItem('tv_tabs');
    location.href = '/';
  });

  $('#btn-copy-link').addEventListener('click', async () => {
    const link = `${location.origin}/r/${state.roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Ссылка скопирована');
    }
  });

  // ---------- Room tabs ----------
  function loadTabs() {
    try {
      const raw = sessionStorage.getItem('tv_tabs');
      if (raw) state.tabs = JSON.parse(raw).filter((t) => t && t.roomId);
    } catch { state.tabs = []; }
  }
  function saveTabs() {
    sessionStorage.setItem('tv_tabs', JSON.stringify(state.tabs));
  }
  function upsertTab(roomId) {
    if (!state.tabs.some((t) => t.roomId === roomId)) {
      state.tabs.push({ roomId });
      saveTabs();
    }
  }
  function renderTabs() {
    roomTabsEl.innerHTML = '';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'room-tab' + (tab.roomId === state.roomId ? ' active' : '');
      el.innerHTML = `
        <button class="room-tab-label" type="button" data-switch="${escapeHtml(tab.roomId)}">${escapeHtml(tab.roomId)}</button>
        <button class="room-tab-close" type="button" data-close="${escapeHtml(tab.roomId)}" title="Закрыть">×</button>
      `;
      roomTabsEl.appendChild(el);
    }
    $$('.room-tab-label', roomTabsEl).forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.switch));
    });
    $$('.room-tab-close', roomTabsEl).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(btn.dataset.close);
      });
    });
  }

  function switchTab(roomId) {
    if (!roomId || roomId === state.roomId || state.joining) return;
    enterRoom(roomId, { addTab: false });
  }

  function closeTab(roomId) {
    state.tabs = state.tabs.filter((t) => t.roomId !== roomId);
    saveTabs();
    if (roomId !== state.roomId) {
      renderTabs();
      return;
    }
    if (state.tabs.length) {
      enterRoom(state.tabs[state.tabs.length - 1].roomId, { addTab: false });
    } else {
      if (state.socket) state.socket.emit('leave-room');
      state.roomId = null;
      location.href = '/';
    }
  }

  $('#btn-new-tab').addEventListener('click', () => {
    $('#open-room-input').value = '';
    $('#modal-open-room').classList.remove('hidden');
    $('#open-room-input').focus();
  });
  $('#open-room-cancel').addEventListener('click', () => {
    $('#modal-open-room').classList.add('hidden');
  });
  $('#open-room-ok').addEventListener('click', () => {
    const code = $('#open-room-input').value.trim() || randomRoomCode();
    $('#modal-open-room').classList.add('hidden');
    enterRoom(code);
  });
  $('#open-room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#open-room-ok').click();
    if (e.key === 'Escape') $('#open-room-cancel').click();
  });

  loadTabs();

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
    } else {
      cancelInlineEdit(true);
      renderKanban();
    }
  }
  $('#tab-canvas').addEventListener('click', () => setView('canvas'));
  $('#tab-kanban').addEventListener('click', () => setView('kanban'));

  // ---------- Tools ----------
  function setTool(tool) {
    state.tool = tool;
    $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvasWrap.style.cursor = tool === 'pan' || state.spaceDown ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    if (tool !== 'connector') {
      state.connectorFromId = null;
      connectorHint.classList.add('hidden');
    } else {
      connectorHint.classList.remove('hidden');
      connectorHint.textContent = 'Выберите фигуру-источник, затем фигуру-цель';
    }
  }
  $$('.tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  $('#stroke-color').addEventListener('input', (e) => {
    state.strokeColor = e.target.value;
  });
  $('#btn-delete').addEventListener('click', deleteSelected);

  function isTypingTarget(el) {
    if (!el) return false;
    if (el === inlineEditEl || inlineEditEl.contains(el)) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape' && state.inlineEdit) {
        e.preventDefault();
        cancelInlineEdit(true);
      }
      return;
    }
    if (e.code === 'Space') {
      state.spaceDown = true;
      canvasWrap.style.cursor = 'grab';
      e.preventDefault();
    }
    const map = {
      KeyV: 'select', KeyH: 'pan', KeyP: 'pen', KeyR: 'rect', KeyO: 'ellipse',
      KeyL: 'line', KeyA: 'arrow', KeyS: 'sticky', KeyT: 'text', KeyC: 'connector',
    };
    if (map[e.code] && !e.metaKey && !e.ctrlKey && !e.altKey) setTool(map[e.code]);
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.view === 'canvas') {
      e.preventDefault();
      deleteSelected();
    }
    if (e.key === 'Escape') {
      state.connectorFromId = null;
      state.selectedIds.clear();
      state.selectedConnectorIds.clear();
      if (state.tool === 'connector') connectorHint.textContent = 'Выберите фигуру-источник, затем фигуру-цель';
      draw();
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
      state.connectors = state.connectors.filter((c) => !set.has(c.fromId) && !set.has(c.toId));
      ids.forEach((id) => state.selectedIds.delete(id));
      draw();
    });
    socket.on('connector-add', (conn) => {
      if (!state.connectors.find((c) => c.id === conn.id)) {
        state.connectors.push(conn);
        draw();
      }
    });
    socket.on('connector-update', (conn) => {
      const i = state.connectors.findIndex((c) => c.id === conn.id);
      if (i >= 0) {
        state.connectors[i] = conn;
        draw();
      }
    });
    socket.on('connector-delete', ({ ids }) => {
      const set = new Set(ids);
      state.connectors = state.connectors.filter((c) => !set.has(c.id));
      ids.forEach((id) => state.selectedConnectorIds.delete(id));
      draw();
    });
    socket.on('card-add', (card) => {
      if (!state.cards.find((c) => c.id === card.id)) state.cards.push(card);
      renderKanban();
      if (state.editingCardId === card.id) syncCardPanel(card);
    });
    socket.on('card-update', (card) => {
      const i = state.cards.findIndex((c) => c.id === card.id);
      if (i >= 0) state.cards[i] = card;
      renderKanban();
      if (state.editingCardId === card.id) syncCardPanel(card);
    });
    socket.on('card-delete', ({ id }) => {
      state.cards = state.cards.filter((c) => c.id !== id);
      if (state.editingCardId === id) closeCardPanel();
      renderKanban();
    });
    socket.on('cards-reorder', ({ cards }) => {
      state.cards = cards;
      renderKanban();
    });
    socket.on('column-add', (col) => {
      if (!state.columns.find((c) => c.id === col.id)) state.columns.push(col);
      renderKanban();
    });
    socket.on('column-rename', ({ id, title }) => {
      const col = state.columns.find((c) => c.id === id);
      if (col) col.title = title;
      renderKanban();
    });
    socket.on('column-delete', ({ id, fallbackColumnId, cards }) => {
      state.columns = state.columns.filter((c) => c.id !== id);
      if (cards) state.cards = cards;
      else {
        for (const c of state.cards) {
          if (c.columnId === id) c.columnId = fallbackColumnId;
        }
      }
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

  // ---------- Geometry helpers ----------
  const SHAPE_TYPES = new Set(['rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event', 'sticky']);

  function centerOf(obj) {
    const b = boundsOf(obj);
    if (!b) return null;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function anchorPoint(obj, toward) {
    const b = boundsOf(obj);
    if (!b) return toward;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const dx = toward.x - cx;
    const dy = toward.y - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };

    if (obj.type === 'circle' || obj.type === 'ellipse' || obj.type === 'event') {
      const rx = Math.max(b.w / 2, 1);
      const ry = Math.max(b.h / 2, 1);
      const ang = Math.atan2(dy / ry, dx / rx);
      return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) };
    }
    if (obj.type === 'gateway') {
      // diamond edges
      const hw = b.w / 2;
      const hh = b.h / 2;
      const sx = dx === 0 ? 0 : Math.sign(dx);
      const sy = dy === 0 ? 0 : Math.sign(dy);
      // parametric: diamond |x|/hw + |y|/hh = 1
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const t = (hw * hh) / (absDy * hw + absDx * hh || 1);
      return { x: cx + dx * t, y: cy + dy * t };
    }
    // AABB edge
    const scaleX = dx !== 0 ? (b.w / 2) / Math.abs(dx) : Infinity;
    const scaleY = dy !== 0 ? (b.h / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(scaleX, scaleY);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function connectorEndpoints(conn) {
    const from = state.objects.find((o) => o.id === conn.fromId);
    const to = state.objects.find((o) => o.id === conn.toId);
    if (!from || !to) return null;
    const cFrom = centerOf(from);
    const cTo = centerOf(to);
    if (!cFrom || !cTo) return null;
    const p1 = anchorPoint(from, cTo);
    const p2 = anchorPoint(to, cFrom);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }

  // ---------- Canvas drawing ----------
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

  function drawRoundedRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, rr);
    else {
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }
  }

  function drawDiamond(x, y, w, h) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(x + w, cy);
    ctx.lineTo(cx, y + h);
    ctx.lineTo(x, cy);
    ctx.closePath();
  }

  function drawStadium(x, y, w, h) {
    const r = h / 2;
    drawRoundedRect(x, y, w, h, r);
  }

  function drawArrowHead(x1, y1, x2, y2, stroke) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = 12;
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - len * Math.cos(ang - 0.4), y2 - len * Math.sin(ang - 0.4));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - len * Math.cos(ang + 0.4), y2 - len * Math.sin(ang + 0.4));
    ctx.stroke();
  }

  function drawObject(obj, { selected = false, hovered = false } = {}) {
    ctx.save();
    ctx.lineWidth = obj.strokeWidth || 2;
    ctx.strokeStyle = obj.stroke || '#1f2937';
    ctx.fillStyle = obj.fill || 'transparent';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const type = obj.type === 'square' ? 'rect' : obj.type;

    if (obj.type === 'pen' && obj.points && obj.points.length) {
      ctx.beginPath();
      obj.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (type === 'rect' || obj.type === 'task') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      const w = Math.abs(obj.w);
      const h = Math.abs(obj.h);
      const radius = obj.type === 'task' ? 16 : 6;
      drawRoundedRect(x, y, w, h, radius);
      if (obj.fill && obj.fill !== 'transparent') ctx.fill();
      ctx.stroke();
      if (obj.label) {
        ctx.fillStyle = obj.stroke || '#1f2937';
        ctx.font = '13px Segoe UI, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(obj.label, x + w / 2, y + h / 2);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    } else if (obj.type === 'circle' || obj.type === 'ellipse') {
      const cx = obj.x + obj.w / 2;
      const cy = obj.y + obj.h / 2;
      const rx = Math.abs(obj.w) / 2;
      const ry = Math.abs(obj.h) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
      if (obj.fill && obj.fill !== 'transparent') ctx.fill();
      ctx.stroke();
      if (obj.label) {
        ctx.fillStyle = obj.stroke || '#1f2937';
        ctx.font = '13px Segoe UI, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(obj.label, cx, cy);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    } else if (obj.type === 'gateway') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      const w = Math.abs(obj.w);
      const h = Math.abs(obj.h);
      drawDiamond(x, y, w, h);
      if (obj.fill && obj.fill !== 'transparent') ctx.fill();
      ctx.stroke();
      if (obj.label) {
        ctx.fillStyle = obj.stroke || '#1f2937';
        ctx.font = '12px Segoe UI, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(obj.label, x + w / 2, y + h / 2);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    } else if (obj.type === 'event') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      const w = Math.abs(obj.w);
      const h = Math.abs(obj.h);
      drawStadium(x, y, w, h);
      if (obj.fill && obj.fill !== 'transparent') ctx.fill();
      ctx.stroke();
      if (obj.label) {
        ctx.fillStyle = obj.stroke || '#1f2937';
        ctx.font = '12px Segoe UI, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(obj.label, x + w / 2, y + h / 2);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    } else if (obj.type === 'line' || obj.type === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(obj.x1, obj.y1);
      ctx.lineTo(obj.x2, obj.y2);
      ctx.stroke();
      if (obj.type === 'arrow') drawArrowHead(obj.x1, obj.y1, obj.x2, obj.y2, obj.stroke || '#1f2937');
    } else if (obj.type === 'sticky') {
      const w = obj.w || 160;
      const h = obj.h || 120;
      ctx.fillStyle = obj.fill || '#fef08a';
      ctx.strokeStyle = 'rgba(0,0,0,.15)';
      drawRoundedRect(obj.x, obj.y, w, h, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1f2937';
      ctx.font = '14px Segoe UI, system-ui, sans-serif';
      wrapText(ctx, obj.text || '', obj.x + 10, obj.y + 24, w - 20, 18);
    } else if (obj.type === 'text') {
      ctx.fillStyle = obj.stroke || getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eef7';
      ctx.font = `${obj.fontSize || 18}px Segoe UI, system-ui, sans-serif`;
      ctx.fillText(obj.text || '', obj.x, obj.y);
    }

    if (selected || hovered) {
      const b = boundsOf(obj);
      if (b) {
        if (hovered && !selected) {
          ctx.shadowColor = getComputedStyle(document.documentElement).getPropertyValue('--hover-glow').trim() || 'rgba(59,130,246,.45)';
          ctx.shadowBlur = 12 / state.camera.scale;
          ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--selection').trim() || '#3b82f6';
          ctx.lineWidth = 1.5 / state.camera.scale;
          ctx.globalAlpha = 0.7;
          ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
          ctx.globalAlpha = 1;
          ctx.shadowBlur = 0;
        }
        if (selected) {
          ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--selection').trim() || '#3b82f6';
          ctx.lineWidth = 1.5 / state.camera.scale;
          ctx.setLineDash([6 / state.camera.scale, 4 / state.camera.scale]);
          ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
          ctx.setLineDash([]);
          // resize handles
          if (SHAPE_TYPES.has(obj.type) && obj.type !== 'text') {
            const hs = 6 / state.camera.scale;
            const corners = [
              [b.x, b.y], [b.x + b.w, b.y],
              [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
            ];
            ctx.fillStyle = ctx.strokeStyle;
            for (const [hx, hy] of corners) {
              ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            }
          }
        }
      }
    }
    ctx.restore();
  }

  function drawConnector(conn, { selected = false, hovered = false } = {}) {
    const ep = connectorEndpoints(conn);
    if (!ep) return;
    ctx.save();
    ctx.lineWidth = (conn.strokeWidth || 2) * (selected || hovered ? 1.3 : 1);
    ctx.strokeStyle = conn.stroke || '#64748b';
    if (hovered && !selected) ctx.globalAlpha = 0.85;
    if (selected) {
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--selection').trim() || '#3b82f6';
    }
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ep.x1, ep.y1);
    ctx.lineTo(ep.x2, ep.y2);
    ctx.stroke();
    if (conn.arrow !== false) drawArrowHead(ep.x1, ep.y1, ep.x2, ep.y2, ctx.strokeStyle);
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
    if (SHAPE_TYPES.has(obj.type) && obj.type !== 'sticky') {
      return {
        x: Math.min(obj.x, obj.x + obj.w),
        y: Math.min(obj.y, obj.y + obj.h),
        w: Math.abs(obj.w) || 1,
        h: Math.abs(obj.h) || 1,
      };
    }
    if (obj.type === 'line' || obj.type === 'arrow') {
      return {
        x: Math.min(obj.x1, obj.x2),
        y: Math.min(obj.y1, obj.y2),
        w: Math.abs(obj.x2 - obj.x1) || 1,
        h: Math.abs(obj.y2 - obj.y1) || 1,
      };
    }
    if (obj.type === 'sticky') return { x: obj.x, y: obj.y, w: obj.w || 160, h: obj.h || 120 };
    if (obj.type === 'text') {
      ctx.save();
      ctx.font = `${obj.fontSize || 18}px Segoe UI, system-ui, sans-serif`;
      const w = ctx.measureText(obj.text || ' ').width;
      ctx.restore();
      return { x: obj.x, y: obj.y - (obj.fontSize || 18), w, h: (obj.fontSize || 18) * 1.2 };
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

  function hitTestConnector(wx, wy) {
    const thresh = 8 / state.camera.scale;
    for (let i = state.connectors.length - 1; i >= 0; i--) {
      const conn = state.connectors[i];
      const ep = connectorEndpoints(conn);
      if (!ep) continue;
      const dist = distToSegment(wx, wy, ep.x1, ep.y1, ep.x2, ep.y2);
      if (dist <= thresh) return conn;
    }
    return null;
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hitResizeHandle(obj, wx, wy) {
    if (!SHAPE_TYPES.has(obj.type) || obj.type === 'text') return null;
    const b = boundsOf(obj);
    if (!b) return null;
    const hs = 8 / state.camera.scale;
    const handles = [
      { corner: 'nw', x: b.x, y: b.y },
      { corner: 'ne', x: b.x + b.w, y: b.y },
      { corner: 'sw', x: b.x, y: b.y + b.h },
      { corner: 'se', x: b.x + b.w, y: b.y + b.h },
    ];
    for (const h of handles) {
      if (Math.abs(wx - h.x) <= hs && Math.abs(wy - h.y) <= hs) return h.corner;
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

    for (const conn of state.connectors) {
      drawConnector(conn, {
        selected: state.selectedConnectorIds.has(conn.id),
        hovered: state.hoverConnectorId === conn.id,
      });
    }
    for (const obj of state.objects) {
      drawObject(obj, {
        selected: state.selectedIds.has(obj.id),
        hovered: state.hoverId === obj.id && !state.selectedIds.has(obj.id),
      });
    }
    if (state.drawing) drawObject(state.drawing, {});
    // preview connector line
    if (state.tool === 'connector' && state.connectorFromId && state._connectorPreview) {
      const from = state.objects.find((o) => o.id === state.connectorFromId);
      if (from) {
        const c = centerOf(from);
        const p1 = anchorPoint(from, state._connectorPreview);
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = state.strokeColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(state._connectorPreview.x, state._connectorPreview.y);
        ctx.stroke();
        ctx.restore();
      }
    }
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
    const objIds = [...state.selectedIds];
    const connIds = [...state.selectedConnectorIds];
    if (!objIds.length && !connIds.length) return;

    if (objIds.length) {
      state.objects = state.objects.filter((o) => !state.selectedIds.has(o.id));
      const orphaned = state.connectors.filter(
        (c) => state.selectedIds.has(c.fromId) || state.selectedIds.has(c.toId)
      );
      state.connectors = state.connectors.filter(
        (c) => !state.selectedIds.has(c.fromId) && !state.selectedIds.has(c.toId)
      );
      state.selectedIds.clear();
      emit('object-delete', { ids: objIds });
      if (orphaned.length) {
        // server also cleans; local already updated
      }
    }
    if (connIds.length) {
      state.connectors = state.connectors.filter((c) => !state.selectedConnectorIds.has(c.id));
      state.selectedConnectorIds.clear();
      emit('connector-delete', { ids: connIds });
    }
    draw();
  }

  function normalizeShape(obj) {
    if (SHAPE_TYPES.has(obj.type) && obj.w !== undefined) {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      let w = Math.abs(obj.w);
      let h = Math.abs(obj.h);
      if (obj.type === 'square' || obj.type === 'circle') {
        const s = Math.max(w, h);
        w = s;
        h = s;
      }
      if (obj.type === 'gateway') {
        const s = Math.max(w, h, 40);
        w = s;
        h = s;
      }
      obj.w = w;
      obj.h = h;
      obj.x = x;
      obj.y = y;
    }
    return obj;
  }

  // ---------- Inline edit ----------
  function startInlineEdit(obj) {
    if (!obj) return;
    if (obj.type !== 'text' && obj.type !== 'sticky' && !['task', 'gateway', 'event', 'rect', 'square', 'circle', 'ellipse'].includes(obj.type)) {
      return;
    }
    cancelInlineEdit(true);
    const b = boundsOf(obj);
    if (!b) return;
    const tl = screenFromWorld(b.x, b.y);
    const br = screenFromWorld(b.x + b.w, b.y + b.h);
    inlineEditEl.classList.remove('hidden');
    inlineEditEl.classList.toggle('sticky-edit', obj.type === 'sticky');
    inlineEditEl.style.left = `${tl.x}px`;
    inlineEditEl.style.top = `${tl.y}px`;
    inlineEditEl.style.width = `${Math.max(80, br.x - tl.x)}px`;
    inlineEditEl.style.height = `${Math.max(28, br.y - tl.y)}px`;
    inlineEditEl.style.fontSize = obj.type === 'text'
      ? `${(obj.fontSize || 18) * state.camera.scale}px`
      : `${14 * state.camera.scale}px`;

    const initial = obj.type === 'text' || obj.type === 'sticky'
      ? (obj.text || '')
      : (obj.label || '');
    inlineEditEl.textContent = initial;
    state.inlineEdit = {
      id: obj.id,
      original: initial,
      field: (obj.type === 'text' || obj.type === 'sticky') ? 'text' : 'label',
    };
    inlineEditEl.focus();
    const range = document.createRange();
    range.selectNodeContents(inlineEditEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function commitInlineEdit() {
    if (!state.inlineEdit) return;
    const { id, field } = state.inlineEdit;
    const value = inlineEditEl.innerText.replace(/\u00a0/g, ' ').trimEnd().slice(0, 500);
    const obj = state.objects.find((o) => o.id === id);
    state.inlineEdit = null;
    inlineEditEl.classList.add('hidden');
    inlineEditEl.textContent = '';
    if (!obj) return;
    if (field === 'text') obj.text = value;
    else obj.label = value;
    emit('object-update', obj);
    draw();
  }

  function cancelInlineEdit(silent) {
    if (!state.inlineEdit) {
      inlineEditEl.classList.add('hidden');
      return;
    }
    state.inlineEdit = null;
    inlineEditEl.classList.add('hidden');
    inlineEditEl.textContent = '';
    if (!silent) draw();
  }

  inlineEditEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelInlineEdit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const obj = state.objects.find((o) => o.id === state.inlineEdit?.id);
      if (obj && obj.type !== 'sticky') {
        e.preventDefault();
        commitInlineEdit();
      }
    }
  });
  inlineEditEl.addEventListener('blur', () => {
    if (state.inlineEdit) commitInlineEdit();
  });

  // ---------- Pointer handlers ----------
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

  let lastClick = { time: 0, id: null };

  canvasWrap.addEventListener('pointerdown', (e) => {
    if (state.view !== 'canvas') return;
    if (e.target === inlineEditEl) return;
    if (state.inlineEdit) commitInlineEdit();

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

    if (state.tool === 'connector') {
      const hit = hitTest(world.x, world.y);
      if (!hit || !SHAPE_TYPES.has(hit.type) && hit.type !== 'text') {
        // allow connecting shapes only
        if (!hit || hit.type === 'pen' || hit.type === 'line' || hit.type === 'arrow') {
          toast('Кликните по фигуре');
          return;
        }
      }
      if (!state.connectorFromId) {
        state.connectorFromId = hit.id;
        state.selectedIds = new Set([hit.id]);
        connectorHint.textContent = 'Теперь выберите фигуру-цель';
        draw();
        return;
      }
      if (hit.id === state.connectorFromId) {
        state.connectorFromId = null;
        connectorHint.textContent = 'Выберите фигуру-источник, затем фигуру-цель';
        draw();
        return;
      }
      const conn = {
        id: uid('conn'),
        type: 'connector',
        fromId: state.connectorFromId,
        toId: hit.id,
        stroke: state.strokeColor,
        strokeWidth: 2,
        arrow: true,
      };
      state.connectors.push(conn);
      emit('connector-add', conn);
      state.connectorFromId = null;
      state.selectedConnectorIds = new Set([conn.id]);
      state.selectedIds.clear();
      connectorHint.textContent = 'Выберите фигуру-источник, затем фигуру-цель';
      draw();
      return;
    }

    if (state.tool === 'select') {
      // resize?
      if (state.selectedIds.size === 1) {
        const sel = state.objects.find((o) => o.id === [...state.selectedIds][0]);
        if (sel) {
          const corner = hitResizeHandle(sel, world.x, world.y);
          if (corner) {
            state.resizing = {
              id: sel.id,
              corner,
              start: world,
              orig: structuredClone(sel),
            };
            return;
          }
        }
      }

      const hit = hitTest(world.x, world.y);
      const hitConn = hit ? null : hitTestConnector(world.x, world.y);

      const now = Date.now();
      if (hit && lastClick.id === hit.id && now - lastClick.time < 350) {
        startInlineEdit(hit);
        lastClick = { time: 0, id: null };
        return;
      }
      lastClick = { time: now, id: hit ? hit.id : null };

      if (hit) {
        if (!e.shiftKey) {
          state.selectedIds.clear();
          state.selectedConnectorIds.clear();
        }
        state.selectedIds.add(hit.id);
        state.dragging = {
          ids: [...state.selectedIds],
          start: world,
          originals: Object.fromEntries(
            state.objects.filter((o) => state.selectedIds.has(o.id)).map((o) => [o.id, structuredClone(o)])
          ),
        };
      } else if (hitConn) {
        if (!e.shiftKey) {
          state.selectedIds.clear();
          state.selectedConnectorIds.clear();
        }
        state.selectedConnectorIds.add(hitConn.id);
      } else {
        state.selectedIds.clear();
        state.selectedConnectorIds.clear();
      }
      draw();
      return;
    }

    const shapeTools = ['rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event'];
    if (shapeTools.includes(state.tool)) {
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
        label: '',
      };
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
      const obj = {
        id: uid('obj'),
        type: 'sticky',
        x: world.x,
        y: world.y,
        w: 160,
        h: 120,
        text: '',
        fill: '#fef08a',
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      draw();
      startInlineEdit(obj);
      return;
    }

    if (state.tool === 'text') {
      const obj = {
        id: uid('obj'),
        type: 'text',
        x: world.x,
        y: world.y,
        text: '',
        stroke: state.strokeColor,
        fontSize: 18,
        w: 120,
        h: 24,
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      draw();
      startInlineEdit(obj);
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

    if (state.resizing) {
      const obj = state.objects.find((o) => o.id === state.resizing.id);
      const orig = state.resizing.orig;
      if (obj && orig) {
        const b = {
          x: Math.min(orig.x, orig.x + orig.w),
          y: Math.min(orig.y, orig.y + orig.h),
          w: Math.abs(orig.w),
          h: Math.abs(orig.h),
        };
        let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        const c = state.resizing.corner;
        if (c.includes('n')) y1 = world.y;
        if (c.includes('s')) y2 = world.y;
        if (c.includes('w')) x1 = world.x;
        if (c.includes('e')) x2 = world.x;
        obj.x = Math.min(x1, x2);
        obj.y = Math.min(y1, y2);
        obj.w = Math.abs(x2 - x1);
        obj.h = Math.abs(y2 - y1);
        if (obj.type === 'square' || obj.type === 'circle' || obj.type === 'gateway') {
          const s = Math.max(obj.w, obj.h, 8);
          obj.w = s;
          obj.h = s;
        }
        emit('object-update', obj);
        draw();
      }
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
      } else if (SHAPE_TYPES.has(d.type) && d.w !== undefined) {
        d.w = world.x - d.x;
        d.h = world.y - d.y;
        if (d.type === 'square' || d.type === 'circle' || d.type === 'gateway') {
          const s = Math.max(Math.abs(d.w), Math.abs(d.h)) * Math.sign(d.w || 1);
          // keep aspect — use absolute max
          const side = Math.max(Math.abs(d.w), Math.abs(d.h));
          d.w = (d.w < 0 ? -1 : 1) * side;
          d.h = (d.h < 0 ? -1 : 1) * side;
        }
      } else if (d.type === 'line' || d.type === 'arrow') {
        d.x2 = world.x;
        d.y2 = world.y;
      }
      draw();
      return;
    }

    // hover
    if (state.tool === 'select' || state.tool === 'connector') {
      const hit = hitTest(world.x, world.y);
      const hitConn = hit ? null : hitTestConnector(world.x, world.y);
      const newHover = hit ? hit.id : null;
      const newHoverC = hitConn ? hitConn.id : null;
      if (newHover !== state.hoverId || newHoverC !== state.hoverConnectorId) {
        state.hoverId = newHover;
        state.hoverConnectorId = newHoverC;
        draw();
      }
      if (state.tool === 'connector' && state.connectorFromId) {
        state._connectorPreview = world;
        draw();
      }
    }
  });

  function applyDelta(obj, orig, dx, dy) {
    if (obj.type === 'pen') {
      obj.points = orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (SHAPE_TYPES.has(obj.type) || obj.type === 'text') {
      obj.x = orig.x + dx;
      obj.y = orig.y + dy;
    } else if (obj.type === 'line' || obj.type === 'arrow') {
      obj.x1 = orig.x1 + dx;
      obj.y1 = orig.y1 + dy;
      obj.x2 = orig.x2 + dx;
      obj.y2 = orig.y2 + dy;
    }
  }

  canvasWrap.addEventListener('pointerup', () => {
    if (state.panning) {
      state.panning = false;
      setTool(state.tool);
    }
    if (state.dragging) state.dragging = null;
    if (state.resizing) {
      const obj = state.objects.find((o) => o.id === state.resizing.id);
      if (obj) {
        normalizeShape(obj);
        emit('object-update', obj);
      }
      state.resizing = null;
      draw();
    }
    if (state.drawing) {
      let obj = state.drawing;
      state.drawing = null;
      if (obj.type === 'pen' && (!obj.points || obj.points.length < 2)) return draw();
      if (SHAPE_TYPES.has(obj.type) && Math.abs(obj.w) < 4 && Math.abs(obj.h) < 4) {
        // default size click
        obj.w = obj.type === 'event' ? 100 : 80;
        obj.h = obj.type === 'event' ? 50 : 80;
        if (obj.type === 'task') { obj.w = 120; obj.h = 70; }
      }
      if ((obj.type === 'line' || obj.type === 'arrow') && Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) < 3) {
        return draw();
      }
      obj = normalizeShape(obj);
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      draw();
    }
  });

  canvasWrap.addEventListener('pointerleave', () => {
    emit('cursor-move', null);
    state.hoverId = null;
    state.hoverConnectorId = null;
    state._connectorPreview = null;
    draw();
  });

  // ---------- Kanban ----------
  function cardsInColumn(colId) {
    return state.cards
      .filter((c) => c.columnId === colId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  function dueUrgency(dueDate) {
    if (!dueDate) return null;
    const due = new Date(dueDate + 'T23:59:59');
    if (Number.isNaN(due.getTime())) return null;
    const now = new Date();
    const days = (due - now) / (1000 * 60 * 60 * 24);
    if (days < 0) return 'overdue';
    if (days <= 1) return 'urgent';
    if (days <= 3) return 'warn';
    if (days <= 7) return 'soon';
    return 'ok';
  }

  function formatDue(dueDate) {
    if (!dueDate) return '';
    try {
      return new Date(dueDate + 'T00:00:00').toLocaleDateString('ru-RU');
    } catch {
      return dueDate;
    }
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
          <button class="kanban-col-del" type="button" data-del-col="${col.id}" title="Удалить колонку">×</button>
        </div>
        <div class="kanban-cards" data-column-id="${col.id}"></div>
        <button class="kanban-add" type="button" data-add="${col.id}">+ Добавить карточку</button>
      `;
      const list = $('.kanban-cards', el);
      for (const card of cards) {
        const urg = dueUrgency(card.dueDate);
        const cardEl = document.createElement('div');
        cardEl.className = 'kanban-card' + (urg ? ` urgency-${urg}` : '');
        cardEl.draggable = true;
        cardEl.dataset.cardId = card.id;
        const dueHtml = card.dueDate
          ? `<span class="kanban-card-due due-${urg || 'ok'}">${escapeHtml(formatDue(card.dueDate))}</span>`
          : '';
        cardEl.innerHTML = `
          <h4>${escapeHtml(card.title)}</h4>
          ${card.description ? `<p>${escapeHtml(card.description)}</p>` : ''}
          ${dueHtml}
        `;
        cardEl.addEventListener('dragstart', (ev) => {
          cardEl.classList.add('dragging');
          ev.dataTransfer.setData('text/plain', card.id);
          ev.dataTransfer.effectAllowed = 'move';
        });
        cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
        cardEl.addEventListener('click', () => openCardPanel(card.id));
        list.appendChild(cardEl);
      }
      list.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        list.classList.add('drag-over');
      });
      list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
      list.addEventListener('drop', (ev) => {
        ev.preventDefault();
        list.classList.remove('drag-over');
        const cardId = ev.dataTransfer.getData('text/plain');
        moveCardToColumn(cardId, col.id);
      });
      kanbanBoard.appendChild(el);
    }

    $$('.kanban-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const columnId = btn.dataset.add;
        emit('card-add', {
          columnId,
          title: 'Новая карточка',
          description: '',
          dueDate: null,
          order: cardsInColumn(columnId).length,
        }, (res) => {
          if (res && res.ok && res.card) openCardPanel(res.card.id);
        });
      });
    });

    $$('.kanban-col-title').forEach((input) => {
      input.addEventListener('change', () => {
        emit('column-rename', { id: input.dataset.col, title: input.value.trim() || 'Колонка' });
      });
    });

    $$('.kanban-col-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.columns.length <= 1) {
          toast('Нужна хотя бы одна колонка');
          return;
        }
        emit('column-delete', { id: btn.dataset.delCol });
      });
    });
  }

  $('#btn-add-column').addEventListener('click', () => {
    emit('column-add', { title: 'Новая колонка' });
  });

  function moveCardToColumn(cardId, columnId) {
    const card = state.cards.find((c) => c.id === cardId);
    if (!card) return;
    const order = cardsInColumn(columnId).filter((c) => c.id !== cardId).length;
    card.columnId = columnId;
    card.order = order;
    emit('card-update', { id: cardId, columnId, order });
    renderKanban();
  }

  function syncCardPanel(card) {
    if (!card || state.editingCardId !== card.id) return;
    if (document.activeElement !== $('#card-title')) $('#card-title').value = card.title;
    if (document.activeElement !== $('#card-desc')) $('#card-desc').value = card.description || '';
    if (document.activeElement !== $('#card-due')) $('#card-due').value = card.dueDate || '';
  }

  function openCardPanel(id) {
    const card = state.cards.find((c) => c.id === id);
    if (!card) return;
    state.editingCardId = id;
    $('#card-title').value = card.title;
    $('#card-desc').value = card.description || '';
    $('#card-due').value = card.dueDate || '';
    cardPanel.classList.remove('hidden');
  }

  function closeCardPanel() {
    cardPanel.classList.add('hidden');
    state.editingCardId = null;
  }

  function saveCardPanel() {
    if (!state.editingCardId) return;
    emit('card-update', {
      id: state.editingCardId,
      title: $('#card-title').value.trim() || 'Без названия',
      description: $('#card-desc').value,
      dueDate: $('#card-due').value || null,
    });
  }

  $('#card-panel-close').addEventListener('click', () => {
    saveCardPanel();
    closeCardPanel();
  });
  $('#card-save-btn').addEventListener('click', () => {
    saveCardPanel();
    closeCardPanel();
    toast('Карточка сохранена');
  });
  $('#card-delete-btn').addEventListener('click', () => {
    if (!state.editingCardId) return;
    emit('card-delete', { id: state.editingCardId });
    closeCardPanel();
  });

  // live field sync while editing
  let cardSyncTimer = null;
  function scheduleCardSync() {
    clearTimeout(cardSyncTimer);
    cardSyncTimer = setTimeout(saveCardPanel, 400);
  }
  $('#card-title').addEventListener('input', scheduleCardSync);
  $('#card-desc').addEventListener('input', scheduleCardSync);
  $('#card-due').addEventListener('change', () => {
    saveCardPanel();
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
    upsertTab(pathMatch[1].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || pathMatch[1]);
    setTimeout(() => enterRoom(pathMatch[1]), 50);
  } else if (pathMatch) {
    // prefill only — user enters name
  }
})();
