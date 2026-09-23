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

  // ---------- Undo / Redo (local client history) ----------
  const HISTORY_LIMIT = 80;
  const CLIPBOARD_KEY = 'tv_object_clipboard';
  let historyPast = [];
  let historyFuture = [];
  let historyLocked = false;
  let objectClipboard = null;

  function cloneBoard() {
    return {
      objects: JSON.parse(JSON.stringify(state.objects || [])),
      connectors: JSON.parse(JSON.stringify(state.connectors || [])),
    };
  }

  function pushHistory() {
    if (historyLocked || !state.roomId) return;
    try {
      historyPast.push(cloneBoard());
      if (historyPast.length > HISTORY_LIMIT) historyPast.shift();
      historyFuture = [];
    } catch (err) {
      console.warn('pushHistory', err);
    }
  }

  function clearHistory() {
    historyPast = [];
    historyFuture = [];
  }

  function applyBoardSnapshot(snap) {
    if (!snap) return;
    historyLocked = true;
    const prevObjs = state.objects.slice();
    const prevConns = state.connectors.slice();
    const nextObjs = Array.isArray(snap.objects) ? snap.objects : [];
    const nextConns = Array.isArray(snap.connectors) ? snap.connectors : [];
    const prevObjMap = new Map(prevObjs.map((o) => [o.id, o]));
    const nextObjMap = new Map(nextObjs.map((o) => [o.id, o]));
    const prevConnMap = new Map(prevConns.map((c) => [c.id, c]));
    const nextConnMap = new Map(nextConns.map((c) => [c.id, c]));

    const delObjIds = [...prevObjMap.keys()].filter((id) => !nextObjMap.has(id));
    const delConnIds = [...prevConnMap.keys()].filter((id) => !nextConnMap.has(id));
    if (delObjIds.length) emit('object-delete', { ids: delObjIds });
    if (delConnIds.length) emit('connector-delete', { ids: delConnIds });

    for (const obj of nextObjs) {
      const prev = prevObjMap.get(obj.id);
      if (!prev) emit('object-add', obj);
      else if (JSON.stringify(prev) !== JSON.stringify(obj)) emit('object-update', obj);
    }
    for (const conn of nextConns) {
      const prev = prevConnMap.get(conn.id);
      if (!prev) emit('connector-add', conn);
      else if (JSON.stringify(prev) !== JSON.stringify(conn)) emit('connector-update', conn);
    }

    state.objects = nextObjs;
    state.connectors = nextConns;
    state.selectedIds.clear();
    state.selectedConnectorIds.clear();
    historyLocked = false;
    draw();
  }

  function undo() {
    if (!historyPast.length || state.view !== 'canvas') return;
    historyFuture.push(cloneBoard());
    applyBoardSnapshot(historyPast.pop());
  }

  function redo() {
    if (!historyFuture.length || state.view !== 'canvas') return;
    historyPast.push(cloneBoard());
    applyBoardSnapshot(historyFuture.pop());
  }

  function saveClipboard(payload) {
    objectClipboard = payload;
    try { sessionStorage.setItem(CLIPBOARD_KEY, JSON.stringify(payload)); } catch { /* ignore */ }
  }

  function loadClipboard() {
    if (objectClipboard && objectClipboard.objects && objectClipboard.objects.length) return objectClipboard;
    try {
      const raw = sessionStorage.getItem(CLIPBOARD_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.objects) && parsed.objects.length) {
        objectClipboard = parsed;
        return parsed;
      }
    } catch { /* ignore */ }
    return null;
  }

  function copySelectedObjects({ cut = false } = {}) {
    if (state.view !== 'canvas' || !state.roomId) return false;
    const ids = [...state.selectedIds];
    if (!ids.length) return false;
    const idSet = new Set(ids);
    const objects = state.objects.filter((o) => idSet.has(o.id)).map((o) => JSON.parse(JSON.stringify(o)));
    const connectors = state.connectors
      .filter((c) => idSet.has(c.fromId) && idSet.has(c.toId))
      .map((c) => JSON.parse(JSON.stringify(c)));
    saveClipboard({ objects, connectors, at: Date.now() });
    if (cut) {
      pushHistory();
      deleteSelected();
      toast('Вырезано');
    } else {
      toast('Скопировано');
    }
    return true;
  }

  function pasteClipboardObjects() {
    if (state.view !== 'canvas' || !state.roomId) return false;
    const clip = loadClipboard();
    if (!clip || !clip.objects || !clip.objects.length) return false;
    pushHistory();
    const idMap = new Map();
    for (const src of clip.objects) {
      if (src && src.id) idMap.set(src.id, uid('obj'));
    }
    const offset = 28;
    const newIds = [];
    for (const src of clip.objects) {
      if (!src || !src.id) continue;
      const copy = JSON.parse(JSON.stringify(src));
      const oldId = src.id;
      copy.id = idMap.get(oldId) || uid('obj');
      if (typeof copy.x === 'number') copy.x += offset;
      if (typeof copy.y === 'number') copy.y += offset;
      if (typeof copy.x1 === 'number') {
        copy.x1 += offset; copy.y1 += offset;
        copy.x2 += offset; copy.y2 += offset;
      }
      if (Array.isArray(copy.points)) {
        copy.points = copy.points.map((p) => ({ x: p.x + offset, y: p.y + offset }));
      }
      if (copy.parentId) copy.parentId = idMap.get(copy.parentId) || null;
      // roomLink / cardLink: keep target refs, new object id
      ensureDbColumns(copy);
      state.objects.push(copy);
      emit('object-add', copy);
      newIds.push(copy.id);
    }
    for (const src of (clip.connectors || [])) {
      if (!src) continue;
      const fromId = idMap.get(src.fromId);
      const toId = idMap.get(src.toId);
      if (!fromId || !toId) continue;
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid('conn');
      copy.fromId = fromId;
      copy.toId = toId;
      state.connectors.push(copy);
      emit('connector-add', copy);
    }
    state.selectedIds = new Set(newIds);
    state.selectedConnectorIds.clear();
    syncColorTargetFromSelection();
    draw();
    toast('Вставлено');
    return true;
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
  const THEMES_FALLBACK = ['black', 'white', 'green', 'blue', 'red', 'orange', 'yellow', 'pink', 'gold'];
  let boardReady = false;

  function listThemes() {
    const fromSelect = $$('#theme-select option, #theme-select-lobby option')
      .map((o) => o.value)
      .filter(Boolean);
    return fromSelect.length ? [...new Set(fromSelect)] : THEMES_FALLBACK.slice();
  }

  function applyTheme(name) {
    const themes = listThemes();
    let theme = String(name || 'black').trim();
    if (!themes.includes(theme)) theme = 'black';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tv_theme', theme);
    const a = $('#theme-select');
    const b = $('#theme-select-lobby');
    if (a) a.value = theme;
    if (b) b.value = theme;
    // draw() closes over canvasWrap; only call after DOM bindings exist
    if (boardReady) draw();
  }
  applyTheme(localStorage.getItem('tv_theme') || 'black');

  // ---------- State ----------
  const TOKEN_KEY = 'tv_token';
  const USER_KEY = 'tv_user';

  const state = {
    socket: null,
    token: localStorage.getItem(TOKEN_KEY) || null,
    account: null, // { id, username, displayName }
    userId: null,
    accountId: null,
    userName: '',
    userColor: '#3b82f6',
    roomId: null,
    sideMode: 'chat', // chat | dm
    dmUsers: [],
    dmOtherId: null,
    dmMessages: [],
    dmTotalUnread: 0,
    notifPermissionAsked: false,
    view: 'canvas',
    tool: 'select',
    strokeColor: '#1f2937',
    textColor: '#1f2937',
    colorTarget: 'shape', // shape | text
    fontSize: 18,
    penStrokeWidth: 2.5,
    pendingPens: [], // freehand drafts while pencil tool stays active
    roomOwnerId: null,
    roomVisibility: 'public',
    roomMembers: [],
    myRoomRole: null,
    lastOtherCursorAt: 0,
    objects: [],
    connectors: [],
    selectedIds: new Set(),
    selectedConnectorIds: new Set(),
    hoverId: null,
    hoverConnectorId: null,
    columns: [],
    cards: [],
    personalColumns: [],
    personalCards: [],
    kanbanMode: 'personal', // personal | room
    messages: [],
    users: new Map(),
    camera: { x: 0, y: 0, scale: 1 },
    drawing: null,
    dragging: null,
    resizing: null,
    rotating: null, // { id, startAngle, origRotation, center }
    marquee: null, // { x1,y1,x2,y2, additive }
    panning: false,
    spaceDown: false,
    lastCursorSent: 0,
    editingCardId: null,
    connectorFromId: null,
    inlineEdit: null,
    editingRoomLinkId: null,
    editingCardLinkId: null,
    tabs: [], // { roomId }
    joining: false,
    lastPointerWorld: null,
  };

  // ---------- DOM ----------
  const authScreen = $('#auth-screen');
  const lobby = $('#lobby');
  const app = $('#app');
  const roomInput = $('#room-input');
  const lobbyError = $('#lobby-error');
  const authError = $('#auth-error');
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
  const roomLinkPanel = $('#room-link-panel');
  const cardLinkPanel = $('#card-link-panel');
  const cardPanel = $('#card-panel');
  const roomTabsEl = $('#room-tabs');
  const dmUsersEl = $('#dm-users');
  const dmMessagesEl = $('#dm-messages');
  const dmInput = $('#dm-input');
  const dmForm = $('#dm-form');
  const dmThreadHead = $('#dm-thread-head');
  const dmBadge = $('#dm-badge');

  const pathMatch = location.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) roomInput.value = pathMatch[1];
  const savedLogin = localStorage.getItem('tv_login') || '';
  if (savedLogin) $('#login-username').value = savedLogin;

  $('#theme-select').addEventListener('change', (e) => applyTheme(e.target.value));
  $('#theme-select-lobby').addEventListener('change', (e) => applyTheme(e.target.value));

  boardReady = true;
  applyTheme(localStorage.getItem('tv_theme') || 'black');

  // ---------- Auth ----------
  function showAuthError(msg) {
    authError.textContent = msg || '';
    authError.classList.toggle('hidden', !msg);
  }

  function setAuthTab(tab) {
    $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.authTab === tab));
    $('#auth-form-login').classList.toggle('hidden', tab !== 'login');
    $('#auth-form-register').classList.toggle('hidden', tab !== 'register');
    showAuthError('');
  }
  $$('.auth-tab').forEach((btn) => {
    btn.addEventListener('click', () => setAuthTab(btn.dataset.authTab));
  });

  function saveSession(token, user) {
    state.token = token;
    state.account = user;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem('tv_login', user.username);
  }

  function clearSession() {
    state.token = null;
    state.account = null;
    state.personalColumns = [];
    state.personalCards = [];
    state.kanbanMode = 'personal';
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
  }

  function accountDisplayName() {
    if (!state.account) return '';
    return (state.account.displayName || state.account.username || '').slice(0, 32);
  }

  function accountInitial() {
    const name = accountDisplayName() || (state.account && state.account.username) || '?';
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  function fillAvatarEl(el, avatarUrl, initial) {
    if (!el) return;
    el.hidden = false;
    if (avatarUrl) {
      el.classList.add('img-avatar');
      el.textContent = '';
      let img = el.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        el.appendChild(img);
      }
      img.src = avatarUrl;
    } else {
      el.classList.remove('img-avatar');
      el.innerHTML = '';
      el.textContent = initial || '?';
    }
  }

  function updateUserChrome() {
    const name = accountDisplayName();
    const lobbyName = $('#lobby-username');
    if (lobbyName) lobbyName.textContent = name;
    const initial = accountInitial();
    const avatarUrl = state.account && state.account.avatarUrl ? state.account.avatarUrl : null;

    const chip = $('#user-chip');
    const chipName = $('#user-chip-name');
    const chipAvatar = $('#user-chip-avatar');
    if (chip) {
      chip.title = state.account
        ? `@${state.account.username} — нажмите, чтобы сменить аватар`
        : '';
    }
    if (chipName) chipName.textContent = name;
    fillAvatarEl(chipAvatar, avatarUrl, initial);

    const lobbyAvatar = $('#lobby-user-avatar');
    fillAvatarEl(lobbyAvatar, avatarUrl, initial);
  }

  function openAvatarPicker() {
    const input = $('#avatar-file-input');
    if (input) input.click();
  }

  function resizeImageToDataUrl(file, maxSize = 256) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('img'));
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          if (w > maxSize || h > maxSize) {
            const scale = Math.min(maxSize / w, maxSize / h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const type = (file.type === 'image/png') ? 'image/png' : 'image/jpeg';
          const quality = type === 'image/jpeg' ? 0.85 : undefined;
          resolve(canvas.toDataURL(type, quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function uploadAvatarFile(file) {
    if (!file || !state.token) return;
    if (!file.type || !file.type.startsWith('image/')) {
      toast('Выберите файл изображения');
      return;
    }
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256);
      // Rough size check on base64 payload
      if (dataUrl.length > 1.1e6) {
        toast('Изображение слишком большое');
        return;
      }
      const { data } = await api('/api/me/avatar', {
        method: 'POST',
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!data || !data.ok) {
        toast((data && data.error) || 'Не удалось загрузить аватар');
        return;
      }
      state.account = data.user;
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      updateUserChrome();
      toast('Аватар обновлён');
    } catch {
      toast('Не удалось загрузить аватар');
    }
  }

  function showLobby() {
    authScreen.classList.add('hidden');
    lobby.classList.remove('hidden');
    app.classList.add('hidden');
    updateUserChrome();
    refreshPublicRooms();
  }

  function showAuth() {
    authScreen.classList.remove('hidden');
    lobby.classList.add('hidden');
    app.classList.add('hidden');
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { res, data };
  }

  async function tryRestoreSession() {
    if (!state.token) {
      showAuth();
      return false;
    }
    try {
      const { res, data } = await api('/api/me');
      if (!res.ok || !data || !data.ok) {
        clearSession();
        showAuth();
        return false;
      }
      state.account = data.user;
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      updateUserChrome();
      ensureSocket();
      showLobby();
      return true;
    } catch {
      clearSession();
      showAuth();
      return false;
    }
  }

  $('#auth-form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (!username || !password) return showAuthError('Введите логин и пароль');
    try {
      const { data } = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (!data || !data.ok) return showAuthError((data && data.error) || 'Ошибка входа');
      saveSession(data.token, data.user);
      $('#login-password').value = '';
      updateUserChrome();
      ensureSocket();
      showLobby();
      maybeAutoJoinRoom();
    } catch {
      showAuthError('Сеть недоступна');
    }
  });

  $('#auth-form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');
    const username = $('#reg-username').value.trim();
    const displayName = $('#reg-displayname').value.trim();
    const password = $('#reg-password').value;
    const password2 = $('#reg-password2').value;
    if (password !== password2) return showAuthError('Пароли не совпадают');
    try {
      const { data } = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ username, password, displayName }),
      });
      if (!data || !data.ok) return showAuthError((data && data.error) || 'Ошибка регистрации');
      saveSession(data.token, data.user);
      $('#reg-password').value = '';
      $('#reg-password2').value = '';
      updateUserChrome();
      ensureSocket();
      showLobby();
      maybeAutoJoinRoom();
      toast('Аккаунт создан');
    } catch {
      showAuthError('Сеть недоступна');
    }
  });

  function logout() {
    if (state.socket) {
      try { state.socket.emit('leave-room'); } catch { /* ignore */ }
    }
    state.roomId = null;
    state.tabs = [];
    sessionStorage.removeItem('tv_tabs');
    clearSession();
    showAuth();
    setAuthTab('login');
    history.replaceState(null, '', '/');
  }

  $('#btn-logout').addEventListener('click', logout);
  $('#btn-logout-lobby').addEventListener('click', logout);

  const avatarInput = $('#avatar-file-input');
  if (avatarInput) {
    avatarInput.addEventListener('change', () => {
      const file = avatarInput.files && avatarInput.files[0];
      avatarInput.value = '';
      if (file) uploadAvatarFile(file);
    });
  }
  const userChip = $('#user-chip');
  if (userChip) userChip.addEventListener('click', openAvatarPicker);
  const btnAvatarLobby = $('#btn-avatar-lobby');
  if (btnAvatarLobby) btnAvatarLobby.addEventListener('click', openAvatarPicker);

  // ---------- Lobby ----------
  function showError(msg) {
    lobbyError.textContent = msg;
    lobbyError.classList.toggle('hidden', !msg);
  }

  function ensureSocket() {
    if (!state.token) return null;
    if (state.socket && state.socket.connected) return state.socket;
    if (state.socket) {
      state.socket.auth = { token: state.token };
      state.socket.connect();
      return state.socket;
    }
    state.socket = io({
      transports: ['websocket', 'polling'],
      auth: { token: state.token },
    });
    bindSocket(state.socket);
    return state.socket;
  }

  function enterRoom(roomId, { addTab = true, create = false, visibility } = {}) {
    if (!state.account || !state.token) {
      showAuth();
      return;
    }
    state.userName = accountDisplayName();
    showError('');
    const socket = ensureSocket();
    if (!socket) {
      showError('Нет соединения');
      return;
    }
    state.joining = true;
    cancelInlineEdit(true);
    const vis = visibility || (document.querySelector('input[name="room-visibility"]:checked') || {}).value || 'public';
    socket.emit('join-room', {
      roomId,
      create: !!create,
      visibility: create ? vis : undefined,
    }, (res) => {
      state.joining = false;
      if (!res || !res.ok) {
        showError((res && res.error) || 'Не удалось войти');
        toast((res && res.error) || 'Не удалось войти');
        return;
      }
      if (addTab) upsertTab(res.roomId);
      applyJoin(res);
      refreshPublicRooms();
    });
  }

  function applyJoin(res) {
    state.userId = res.userId;
    state.accountId = res.accountId || (state.account && state.account.id);
    state.userName = res.name;
    state.userColor = res.color;
    state.roomId = res.roomId;
    clearHistory();
    const s = res.state || {};
    state.objects = s.objects || [];
    state.connectors = s.connectors || [];
    state.columns = s.columns || [];
    state.cards = (s.cards || []).map((c) => ({ dueDate: null, ...c }));
    state.messages = s.messages || [];
    state.users = new Map((s.users || []).map((u) => [u.id, u]));
    state.roomOwnerId = s.ownerId || res.accountId || null;
    state.roomVisibility = s.visibility || 'public';
    state.roomMembers = s.members || [];
    state.myRoomRole = res.myRole || (res.isOwner ? 'owner' : 'member');
    state.lastOtherCursorAt = 0;
    state.selectedIds.clear();
    state.selectedConnectorIds.clear();
    state.hoverId = null;
    state.connectorFromId = null;
    connectorHint.classList.add('hidden');
    closeCardPanel();
    closeRoomLinkPanel();

    const url = `/r/${state.roomId}`;
    if (location.pathname !== url) history.replaceState(null, '', url);

    authScreen.classList.add('hidden');
    lobby.classList.add('hidden');
    app.classList.remove('hidden');
    const vis = state.roomVisibility === 'private' ? '🔒 ' : '';
    $('#room-badge').textContent = vis + state.roomId;
    updateRoomOwnerChrome();
    updateKanbanChrome();
    updateUserChrome();
    renderTabs();
    renderPresence();
    renderChat();
    renderKanban();
    refreshDmUsers();
    updateNotifButton();
    resizeCanvas();
    draw();
    setView(state.view);
  }

  $('#btn-create').addEventListener('click', () => {
    const code = roomInput.value.trim() || randomRoomCode();
    roomInput.value = code;
    enterRoom(code, { create: true });
  });
  $('#btn-join').addEventListener('click', () => {
    const code = roomInput.value.trim();
    if (!code) return showError('Введите код комнаты');
    enterRoom(code);
  });
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join').click();
  });

  $('#btn-leave').addEventListener('click', () => {
    if (state.socket) state.socket.emit('leave-room');
    state.roomId = null;
    state.tabs = [];
    sessionStorage.removeItem('tv_tabs');
    history.replaceState(null, '', '/');
    app.classList.add('hidden');
    showLobby();
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
    state.tabs.forEach((tab, index) => {
      const el = document.createElement('div');
      el.className = 'room-tab' + (tab.roomId === state.roomId ? ' active' : '');
      el.draggable = true;
      el.dataset.roomId = tab.roomId;
      el.dataset.index = String(index);
      const lock = tab.visibility === 'private' ? '🔒 ' : '';
      el.innerHTML = `
        <button class="room-tab-label" type="button" data-switch="${escapeHtml(tab.roomId)}">${lock}${escapeHtml(tab.roomId)}</button>
        <button class="room-tab-close" type="button" data-close="${escapeHtml(tab.roomId)}" title="Закрыть">×</button>
      `;
      el.addEventListener('dragstart', (e) => {
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.roomId);
        state._tabDragId = tab.roomId;
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        $$('.room-tab', roomTabsEl).forEach((t) => t.classList.remove('drag-over', 'drag-over-after'));
        state._tabDragId = null;
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        const fromId = state._tabDragId;
        if (!fromId || fromId === tab.roomId) return;
        const rect = el.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        el.classList.toggle('drag-over', !after);
        el.classList.toggle('drag-over-after', after);
      });
      el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over', 'drag-over-after');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromId = e.dataTransfer.getData('text/plain') || state._tabDragId;
        el.classList.remove('drag-over', 'drag-over-after');
        if (!fromId || fromId === tab.roomId) return;
        const from = state.tabs.findIndex((t) => t.roomId === fromId);
        let to = state.tabs.findIndex((t) => t.roomId === tab.roomId);
        if (from < 0 || to < 0) return;
        const rect = el.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        const [item] = state.tabs.splice(from, 1);
        if (from < to) to -= 1;
        if (after) to += 1;
        state.tabs.splice(to, 0, item);
        saveTabs();
        renderTabs();
      });
      roomTabsEl.appendChild(el);
    });
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
      history.replaceState(null, '', '/');
      app.classList.add('hidden');
      showLobby();
    }
  }

  $('#btn-new-tab').addEventListener('click', () => {
    $('#open-room-input').value = '';
    $('#modal-open-room').classList.remove('hidden');
    refreshPublicRooms();
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
  function setKanbanMode(mode) {
    state.kanbanMode = mode === 'room' ? 'room' : 'personal';
    closeCardPanel();
    updateKanbanChrome();
    if (state.view === 'kanban') renderKanban();
  }

  function updateKanbanChrome() {
    const personal = state.kanbanMode === 'personal';
    const titleEl = $('#kanban-board-title');
    if (titleEl) {
      titleEl.textContent = personal
        ? 'Мой канбан'
        : ('Канбан комнаты · ' + (state.roomId || '—'));
    }
    const btnPers = $('#btn-kanban-personal');
    const btnRoom = $('#btn-kanban-room');
    if (btnPers) {
      btnPers.classList.toggle('hidden', personal);
      btnPers.classList.toggle('active', personal);
    }
    if (btnRoom) {
      btnRoom.classList.toggle('hidden', !personal);
      btnRoom.classList.toggle('active', !personal);
    }
    $('#tab-canvas').classList.toggle('active', state.view === 'canvas');
    $('#tab-kanban').classList.toggle('active', state.view === 'kanban' && personal);
    const roomTab = $('#tab-room-kanban');
    if (roomTab) roomTab.classList.toggle('active', state.view === 'kanban' && !personal);
  }

  function setView(view, opts) {
    opts = opts || {};
    state.view = view;
    if (view === 'kanban' && opts.kanbanMode) {
      state.kanbanMode = opts.kanbanMode === 'room' ? 'room' : 'personal';
    }
    $('#view-canvas').classList.toggle('hidden', view !== 'canvas');
    $('#view-kanban').classList.toggle('hidden', view !== 'kanban');
    updateKanbanChrome();
    if (view === 'canvas') {
      resizeCanvas();
      draw();
    } else {
      cancelInlineEdit(true);
      renderKanban();
    }
  }
  $('#tab-canvas').addEventListener('click', () => setView('canvas'));
  $('#tab-kanban').addEventListener('click', () => setView('kanban', { kanbanMode: 'personal' }));
  const tabRoomKanban = $('#tab-room-kanban');
  if (tabRoomKanban) {
    tabRoomKanban.addEventListener('click', () => setView('kanban', { kanbanMode: 'room' }));
  }
  const btnKanbanPersonal = $('#btn-kanban-personal');
  const btnKanbanRoom = $('#btn-kanban-room');
  if (btnKanbanPersonal) {
    btnKanbanPersonal.addEventListener('click', () => setView('kanban', { kanbanMode: 'personal' }));
  }
  if (btnKanbanRoom) {
    btnKanbanRoom.addEventListener('click', () => setView('kanban', { kanbanMode: 'room' }));
  }

  // ---------- Tools ----------
  const DB_TYPES = new Set([
    'dbTable', 'dbView', 'dbSchema', 'dbDatabase', 'dbIndex', 'dbProcedure', 'dbTrigger', 'dbEnum',
  ]);
  const ROTATABLE_TYPES = new Set([
    'rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event',
    'sticky', 'text', 'roomLink', 'cardLink', 'image',
    ...DB_TYPES,
  ]);

  function commitPendingPens() {
    if (!state.pendingPens || !state.pendingPens.length) return;
    const pens = state.pendingPens.splice(0, state.pendingPens.length);
    for (const obj of pens) {
      if (!obj.points || obj.points.length < 2) continue;
      state.objects.push(obj);
      emit('object-add', obj);
    }
    draw();
  }

  function setTool(tool) {
    const prev = state.tool;
    if (prev === 'pen' && tool !== 'pen') {
      // finalize draft stroke if mid-draw, then commit all pending freehands
      if (state.drawing && state.drawing.type === 'pen') {
        const draft = state.drawing;
        state.drawing = null;
        if (draft.points && draft.points.length >= 2) state.pendingPens.push(draft);
      }
      commitPendingPens();
    }
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
    if (tool === 'text' || tool === 'sticky') setColorTarget('text');
    else if (
      tool === 'pen' || tool === 'line' || tool === 'arrow' || tool === 'roomLink' || tool === 'cardLink' ||
      ['rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event'].includes(tool) ||
      DB_TYPES.has(tool)
    ) {
      setColorTarget('shape');
    }
    syncRotationUI();
    syncPenWidthUI();
  }
  $$('.tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  function closeToolPopovers() {
    $$('.tool-popover, [data-group-panel]').forEach((p) => p.classList.add('hidden'));
    $$('[data-group-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
  function closeToolDrawer() {
    const drawer = $('#toolbar-drawer');
    const btn = $('#btn-tool-drawer');
    if (drawer) { drawer.classList.add('hidden'); drawer.setAttribute('aria-hidden', 'true'); }
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function closeDbColumnsPanel() {
    const panel = $('#db-columns-panel');
    if (panel) panel.classList.add('hidden');
    if (typeof dbColumnsEditId !== 'undefined') dbColumnsEditId = null;
  }
  function isAppAdminUser() {
    return !!(state.account && state.account.isAdmin);
  }

  $$('[data-group-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = btn.getAttribute('data-group-toggle');
      const panel = document.querySelector(`[data-group-panel="${group}"]`);
      const wasOpen = panel && !panel.classList.contains('hidden');
      closeToolPopovers();
      closeToolDrawer();
      if (panel && !wasOpen) {
        panel.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
  {
    const btnDrawer = $('#btn-tool-drawer');
    if (btnDrawer && !btnDrawer._tvBound) {
      btnDrawer._tvBound = true;
      btnDrawer.addEventListener('click', (e) => {
        e.stopPropagation();
        const drawer = $('#toolbar-drawer');
        if (!drawer) return;
        const opening = drawer.classList.contains('hidden');
        closeToolPopovers();
        if (opening) {
          drawer.classList.remove('hidden');
          drawer.setAttribute('aria-hidden', 'false');
          btnDrawer.setAttribute('aria-expanded', 'true');
        } else closeToolDrawer();
      });
    }
    const btnClose = $('#btn-tool-drawer-close');
    if (btnClose && !btnClose._tvBound) {
      btnClose._tvBound = true;
      btnClose.addEventListener('click', () => closeToolDrawer());
    }
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-group-panel]') || e.target.closest('[data-group-toggle]') || e.target.closest('#toolbar-drawer') || e.target.closest('#btn-tool-drawer')) return;
    closeToolPopovers();
  });

  function getActiveColor() {
    return state.colorTarget === 'text' ? state.textColor : state.strokeColor;
  }

  function syncColorUI(color) {
    const c = color || getActiveColor();
    const stroke = $('#stroke-color');
    const palette = $('#palette-color');
    if (stroke) stroke.value = c;
    if (palette) palette.value = c;
    $$('#color-palette .swatch[data-color]').forEach((b) => {
      b.classList.toggle('active', b.dataset.color.toLowerCase() === String(c).toLowerCase());
    });
    $$('#color-palette .palette-mode').forEach((btn) => {
      const on = btn.dataset.colorTarget === state.colorTarget;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function syncFontSizeUI(size) {
    const input = $('#font-size-input');
    if (input) input.value = String(size);
  }

  function clampFontSize(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return state.fontSize || 18;
    return Math.max(10, Math.min(72, v));
  }

  function themeTextColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eef7';
  }

  function objectTextColor(obj) {
    if (!obj) return themeTextColor();
    if (obj.textColor) return obj.textColor;
    if (obj.type === 'text') return obj.stroke || themeTextColor();
    if (obj.type === 'sticky') return '#1f2937';
    return themeTextColor();
  }

  function objectFontSize(obj) {
    if (obj && obj.fontSize != null && obj.fontSize !== '') return obj.fontSize;
    if (!obj) return state.fontSize || 18;
    if (obj.type === 'text') return 18;
    if (obj.type === 'sticky') return 14;
    if (obj.type === 'gateway' || obj.type === 'event') return 12;
    if (obj.type === 'roomLink' || obj.type === 'cardLink') return 14;
    if (obj.type === 'arrow' || obj.type === 'line') return 14;
    return 13;
  }

  const TEXT_COLOR_TYPES = new Set([
    'rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event',
    'sticky', 'text', 'roomLink', 'cardLink', 'line', 'arrow',
    'dbTable', 'dbView', 'dbSchema', 'dbDatabase', 'dbIndex', 'dbProcedure', 'dbTrigger', 'dbEnum',
  ]);
  const FONT_SIZE_TYPES = new Set([
    'rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event',
    'sticky', 'text', 'roomLink', 'cardLink', 'line', 'arrow',
    'dbTable', 'dbView', 'dbSchema', 'dbDatabase', 'dbIndex', 'dbProcedure', 'dbTrigger', 'dbEnum',
  ]);


  function isTextPrimaryObject(obj) {
    return !!(obj && (obj.type === 'text' || obj.type === 'sticky'));
  }

  /** Auto-pick palette mode from selection: text/sticky → text color, shapes/arrows → figure color. */
  function syncColorTargetFromSelection() {
    const objs = [...state.selectedIds]
      .map((id) => state.objects.find((o) => o.id === id))
      .filter(Boolean);
    const conns = [...state.selectedConnectorIds]
      .map((id) => state.connectors.find((c) => c.id === id))
      .filter(Boolean);

    // Connectors (arrow links between shapes): always figure/stroke color
    if (!objs.length && conns.length) {
      state.colorTarget = 'shape';
      if (conns.length === 1 && conns[0].stroke) state.strokeColor = conns[0].stroke;
      syncColorUI();
      syncRotationUI();
      return;
    }
    if (!objs.length) return;

    // Arrows/lines/pens are stroke-primary — never auto-switch to text color on click
    const strokePrimary = (o) => o && (o.type === 'arrow' || o.type === 'line' || o.type === 'pen');
    const target = objs.every(isTextPrimaryObject) && !objs.some(strokePrimary) ? 'text' : 'shape';
    state.colorTarget = target;

    if (objs.length === 1) {
      const o = objs[0];
      if (target === 'text') {
        state.textColor = objectTextColor(o);
      } else if (o.type === 'sticky') {
        state.strokeColor = o.fill || state.strokeColor;
      } else if (o.stroke) {
        state.strokeColor = o.stroke;
      }
      syncFontSizeUI(objectFontSize(o));
      if (o.type === 'pen') syncPenWidthUI(o.strokeWidth || state.penStrokeWidth);
      syncRotationUI(o.rotation || 0);
    } else {
      syncRotationUI();
    }
    syncColorUI();
  }

  function setColorTarget(target) {
    if (target !== 'shape' && target !== 'text') return;
    state.colorTarget = target;
    syncColorUI(getActiveColor());
  }

  function setActiveColor(color, { applyToSelection = true } = {}) {
    if (!color) return;
    if (state.colorTarget === 'text') state.textColor = color;
    else state.strokeColor = color;
    syncColorUI(color);
    if (!applyToSelection) return;
    if (state.selectedIds.size || state.selectedConnectorIds.size) pushHistory();
    let changed = false;
    if (state.colorTarget === 'text') {
      for (const id of state.selectedIds) {
        const obj = state.objects.find((o) => o.id === id);
        if (!obj || !TEXT_COLOR_TYPES.has(obj.type)) continue;
        obj.textColor = color;
        if (obj.type === 'text') obj.stroke = color; // backward compat
        emit('object-update', obj);
        changed = true;
      }
    } else {
      for (const id of state.selectedIds) {
        const obj = state.objects.find((o) => o.id === id);
        if (!obj) continue;
        if (obj.type === 'sticky') {
          obj.fill = color;
        } else if (obj.type === 'text') {
          // figure mode does not retarget pure text; keep stroke for drawing tools only
          obj.stroke = color;
          obj.textColor = color;
        } else if ('stroke' in obj) {
          obj.stroke = color;
        } else {
          continue;
        }
        emit('object-update', obj);
        changed = true;
      }
      for (const id of state.selectedConnectorIds) {
        const conn = state.connectors.find((c) => c.id === id);
        if (!conn) continue;
        conn.stroke = color;
        emit('connector-update', conn);
        changed = true;
      }
    }
    if (changed) draw();
  }

  // Back-compat alias used nowhere else but keep name for clarity
  function setStrokeColor(color, opts) {
    setActiveColor(color, opts);
  }

  function setFontSize(size, { applyToSelection = true } = {}) {
    const next = clampFontSize(size);
    state.fontSize = next;
    syncFontSizeUI(next);
    if (!applyToSelection) return;
    if (state.selectedIds.size) pushHistory();
    let changed = false;
    for (const id of state.selectedIds) {
      const obj = state.objects.find((o) => o.id === id);
      if (!obj || !FONT_SIZE_TYPES.has(obj.type)) continue;
      obj.fontSize = next;
      emit('object-update', obj);
      changed = true;
    }
    if (changed) draw();
  }

  $('#stroke-color').addEventListener('input', (e) => setActiveColor(e.target.value));
  const paletteColor = $('#palette-color');
  if (paletteColor) {
    paletteColor.addEventListener('input', (e) => setActiveColor(e.target.value));
  }
  $$('#color-palette .swatch[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => setActiveColor(btn.dataset.color));
  });
  $$('#color-palette .palette-mode').forEach((btn) => {
    btn.addEventListener('click', () => setColorTarget(btn.dataset.colorTarget));
  });
  const fontSizeInput = $('#font-size-input');
  if (fontSizeInput) {
    fontSizeInput.addEventListener('change', (e) => setFontSize(e.target.value));
    fontSizeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setFontSize(e.target.value);
        e.target.blur();
      }
    });
  }
  const fontDec = $('#font-size-dec');
  const fontInc = $('#font-size-inc');
  if (fontDec) fontDec.addEventListener('click', () => setFontSize((state.fontSize || 18) - 1));
  if (fontInc) fontInc.addEventListener('click', () => setFontSize((state.fontSize || 18) + 1));

  function clampPenWidth(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return state.penStrokeWidth || 2.5;
    return Math.max(1, Math.min(32, Math.round(v * 2) / 2));
  }
  function syncPenWidthUI(w) {
    const input = $('#pen-width-input');
    if (input) input.value = String(w != null ? w : (state.penStrokeWidth || 2.5));
  }
  function setPenWidth(w, { applyToSelection = true } = {}) {
    const next = clampPenWidth(w);
    state.penStrokeWidth = next;
    syncPenWidthUI(next);
    if (!applyToSelection) return;
    let changed = false;
    for (const id of state.selectedIds) {
      const obj = state.objects.find((o) => o.id === id);
      if (!obj || obj.type !== 'pen') continue;
      obj.strokeWidth = next;
      emit('object-update', obj);
      changed = true;
    }
    if (changed) draw();
  }
  const penWidthInput = $('#pen-width-input');
  if (penWidthInput) {
    penWidthInput.addEventListener('change', (e) => setPenWidth(e.target.value));
    penWidthInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); setPenWidth(e.target.value); e.target.blur(); }
    });
  }
  const penDec = $('#pen-width-dec');
  const penInc = $('#pen-width-inc');
  if (penDec) penDec.addEventListener('click', () => setPenWidth((state.penStrokeWidth || 2.5) - 0.5));
  if (penInc) penInc.addEventListener('click', () => setPenWidth((state.penStrokeWidth || 2.5) + 0.5));

  function clampRotation(n) {
    let v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 0;
    v = ((v % 360) + 360) % 360;
    if (v > 180) v -= 360;
    return v;
  }
  function syncRotationUI(deg) {
    const input = $('#rotation-input');
    if (!input) return;
    if (deg != null) {
      input.value = String(clampRotation(deg));
      return;
    }
    if (state.selectedIds.size === 1) {
      const obj = state.objects.find((o) => o.id === [...state.selectedIds][0]);
      if (obj && ROTATABLE_TYPES.has(obj.type)) {
        input.value = String(clampRotation(obj.rotation || 0));
        return;
      }
    }
    input.value = '0';
  }
  function setRotation(deg, { applyToSelection = true } = {}) {
    const next = clampRotation(deg);
    syncRotationUI(next);
    if (!applyToSelection) return;
    let changed = false;
    for (const id of state.selectedIds) {
      const obj = state.objects.find((o) => o.id === id);
      if (!obj || !ROTATABLE_TYPES.has(obj.type)) continue;
      obj.rotation = next;
      emit('object-update', obj);
      changed = true;
    }
    if (changed) draw();
  }
  const rotationInput = $('#rotation-input');
  if (rotationInput) {
    rotationInput.addEventListener('change', (e) => setRotation(e.target.value));
    rotationInput.addEventListener('input', (e) => {
      if (state.selectedIds.size) setRotation(e.target.value);
    });
    rotationInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); setRotation(e.target.value); e.target.blur(); }
    });
  }

  syncColorUI(getActiveColor());
  syncFontSizeUI(state.fontSize);
  syncPenWidthUI();
  syncRotationUI();
  $('#btn-delete').addEventListener('click', deleteSelected);

  function isTypingTarget(el) {
    if (!el) return false;
    if (state.inlineEdit) return true;
    if (el === inlineEditEl || inlineEditEl.contains(el)) return true;
    if (roomLinkPanel && (el === roomLinkPanel || roomLinkPanel.contains(el))) return true;
    if (cardLinkPanel && (el === cardLinkPanel || cardLinkPanel.contains(el))) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) {
      const dbPanel = $('#db-columns-panel');
      const inDbPanel = !!(dbPanel && !dbPanel.classList.contains('hidden') && (
        dbPanel.contains(e.target) || dbPanel.contains(document.activeElement)
      ));
      if (e.key === 'Escape' && inDbPanel) {
        e.preventDefault();
        closeDbColumnsPanel();
        setTool('select');
        return;
      }
      if (e.key === 'Escape' && state.inlineEdit) {
        e.preventDefault();
        cancelInlineEdit(true);
        setTool('select');
        return;
      }
      // Never steal keys from the DB columns panel into canvas inline edit
      if (inDbPanel) return;
      // If focus left the editor, put it back and apply the key so typing still works
      if (state.inlineEdit && document.activeElement !== inlineEditEl) {
        inlineEditEl.focus({ preventScroll: true });
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          document.execCommand('insertText', false, e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          document.execCommand('delete');
        } else if (e.key === 'Enter' && !e.shiftKey) {
          const obj = state.objects.find((o) => o.id === state.inlineEdit?.id);
          if (obj && obj.type === 'sticky') {
            e.preventDefault();
            document.execCommand('insertText', false, '\n');
          }
        }
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
    // Undo / Redo / Clipboard
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
        return;
      }
      if (k === 'c') {
        e.preventDefault();
        copySelectedObjects();
        return;
      }
      if (k === 'x') {
        e.preventDefault();
        copySelectedObjects({ cut: true });
        return;
      }
      if (k === 'v') {
        e.preventDefault();
        pasteClipboardObjects();
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Close panels / editors first
      const dbPanel = $('#db-columns-panel');
      if (dbPanel && !dbPanel.classList.contains('hidden')) {
        closeDbColumnsPanel();
        setTool('select');
        return;
      }
      if (roomLinkPanel && !roomLinkPanel.classList.contains('hidden')) {
        closeRoomLinkPanel();
        setTool('select');
        return;
      }
      if (cardLinkPanel && !cardLinkPanel.classList.contains('hidden')) {
        closeCardLinkPanel();
        setTool('select');
        return;
      }
      if (state.inlineEdit) {
        cancelInlineEdit(true);
        setTool('select');
        return;
      }
      closeToolPopovers();
      closeToolDrawer();
      // Cancel in-progress drawing / gestures
      state.drawing = null;
      state.dragging = null;
      state.resizing = null;
      state.rotating = null;
      state.marquee = null;
      state.connectorFromId = null;
      state.selectedIds.clear();
      state.selectedConnectorIds.clear();
      setTool('select');
      draw();
      return;
    }
    if (e.key === 'Enter' && state.view === 'canvas' && state.selectedIds.size === 1) {
      const sel = state.objects.find((o) => o.id === [...state.selectedIds][0]);
      if (sel && sel.type === 'roomLink') {
        e.preventDefault();
        openRoomLinkPanel(sel);
      } else if (sel && sel.type === 'cardLink') {
        e.preventDefault();
        openCardLinkPanel(sel);
      }
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
        if (id !== state.userId && cursor) {
          state.lastOtherCursorAt = Date.now();
          refreshChatReadReceipts();
        }
        renderCursors();
      }
    });
    socket.on('public-rooms', (rooms) => {
      renderPublicRoomsList(Array.isArray(rooms) ? rooms : []);
    });
    socket.on('room-deleted', ({ roomId }) => {
      if (roomId && roomId === state.roomId) {
        toast('Комната удалена владельцем');
        closeTab(roomId);
      } else if (roomId) {
        state.tabs = state.tabs.filter((t) => t.roomId !== roomId);
        saveTabs();
        renderTabs();
      }
      refreshPublicRooms();
    });
    socket.on('room-members', ({ roomId, members }) => {
      if (roomId === state.roomId) {
        state.roomMembers = members || [];
        renderMembersPanel();
      }
    });
    socket.on('room-kicked', ({ reason }) => {
      toast(reason || 'Вас удалили из комнаты');
      if (state.roomId) closeTab(state.roomId);
    });
    socket.on('room-invite-notice', (payload) => {
      if (!payload) return;
      toast(`Приглашение в комнату ${payload.roomId} от ${payload.fromName || 'пользователя'}`);
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
      if (state.kanbanMode === 'room') {
        renderKanban();
        if (state.editingCardId === card.id) syncCardPanel(card);
      }
      if (state.view === 'canvas' && state.objects.some((o) => o.type === 'cardLink')) draw();
      if (state.editingCardLinkId && $('#card-link-board').value === 'room') {
        fillCardLinkCardSelect('room', $('#card-link-card').value);
      }
    });
    socket.on('card-update', (card) => {
      const i = state.cards.findIndex((c) => c.id === card.id);
      if (i >= 0) state.cards[i] = card;
      if (state.kanbanMode === 'room') {
        renderKanban();
        if (state.editingCardId === card.id) syncCardPanel(card);
      }
      if (state.view === 'canvas' && state.objects.some((o) => o.type === 'cardLink' && o.cardId === card.id)) draw();
      if (state.editingCardLinkId && $('#card-link-board').value === 'room') {
        fillCardLinkCardSelect('room', $('#card-link-card').value);
      }
    });
    socket.on('card-delete', ({ id }) => {
      state.cards = state.cards.filter((c) => c.id !== id);
      if (state.editingCardId === id && state.kanbanMode === 'room') closeCardPanel();
      if (state.kanbanMode === 'room') renderKanban();
    });
    socket.on('cards-reorder', ({ cards }) => {
      state.cards = cards;
      if (state.kanbanMode === 'room') renderKanban();
    });
    socket.on('column-add', (col) => {
      if (!state.columns.find((c) => c.id === col.id)) state.columns.push(col);
      if (state.kanbanMode === 'room') renderKanban();
    });
    socket.on('column-rename', ({ id, title }) => {
      const col = state.columns.find((c) => c.id === id);
      if (col) col.title = title;
      if (state.kanbanMode === 'room') renderKanban();
    });
    socket.on('column-delete', ({ id, fallbackColumnId, cards }) => {
      state.columns = state.columns.filter((c) => c.id !== id);
      if (cards) state.cards = cards;
      else {
        for (const c of state.cards) {
          if (c.columnId === id) c.columnId = fallbackColumnId;
        }
      }
      if (state.kanbanMode === 'room') renderKanban();
    });

    socket.on('personal-kanban-state', (payload) => {
      applyPersonalKanbanState(payload);
    });
    socket.on('personal-card-add', (card) => {
      if (!state.personalCards.find((c) => c.id === card.id)) state.personalCards.push(card);
      if (state.kanbanMode === 'personal') {
        renderKanban();
        if (state.editingCardId === card.id) syncCardPanel(card);
      }
      if (state.view === 'canvas' && state.objects.some((o) => o.type === 'cardLink')) draw();
      if (state.editingCardLinkId && $('#card-link-board').value === 'personal') {
        fillCardLinkCardSelect('personal', $('#card-link-card').value);
      }
    });
    socket.on('personal-card-update', (card) => {
      const i = state.personalCards.findIndex((c) => c.id === card.id);
      if (i >= 0) state.personalCards[i] = card;
      if (state.kanbanMode === 'personal') {
        renderKanban();
        if (state.editingCardId === card.id) syncCardPanel(card);
      }
      if (state.view === 'canvas' && state.objects.some((o) => o.type === 'cardLink' && o.cardId === card.id)) draw();
      if (state.editingCardLinkId && $('#card-link-board').value === 'personal') {
        fillCardLinkCardSelect('personal', $('#card-link-card').value);
      }
    });
    socket.on('personal-card-delete', ({ id }) => {
      state.personalCards = state.personalCards.filter((c) => c.id !== id);
      if (state.editingCardId === id && state.kanbanMode === 'personal') closeCardPanel();
      if (state.kanbanMode === 'personal') renderKanban();
    });
    socket.on('personal-cards-reorder', ({ cards }) => {
      state.personalCards = cards;
      if (state.kanbanMode === 'personal') renderKanban();
    });
    socket.on('personal-column-add', (col) => {
      if (!state.personalColumns.find((c) => c.id === col.id)) state.personalColumns.push(col);
      if (state.kanbanMode === 'personal') renderKanban();
    });
    socket.on('personal-column-update', ({ id, title }) => {
      const col = state.personalColumns.find((c) => c.id === id);
      if (col) col.title = title;
      if (state.kanbanMode === 'personal') renderKanban();
    });
    socket.on('personal-column-rename', ({ id, title }) => {
      const col = state.personalColumns.find((c) => c.id === id);
      if (col) col.title = title;
      if (state.kanbanMode === 'personal') renderKanban();
    });
    socket.on('personal-column-delete', ({ id, fallbackColumnId, cards }) => {
      state.personalColumns = state.personalColumns.filter((c) => c.id !== id);
      if (cards) state.personalCards = cards;
      else {
        for (const c of state.personalCards) {
          if (c.columnId === id) c.columnId = fallbackColumnId;
        }
      }
      if (state.kanbanMode === 'personal') renderKanban();
    });
    socket.on('chat-message', (msg) => {
      if (!state.messages.find((m) => m.id === msg.id)) {
        state.messages.push(msg);
        if (state.messages.length > 100) state.messages = state.messages.slice(-100);
        appendChatMessage(msg, true);
        maybeNotifyRoomChat(msg);
      }
    });
    socket.on('auth-ok', (payload) => {
      if (payload && payload.user) {
        state.account = payload.user;
        updateUserChrome();
      }
      if (payload && typeof payload.totalUnread === 'number') {
        state.dmTotalUnread = payload.totalUnread;
        updateDmBadge();
      }
      refreshDmUsers();
    });
    socket.on('users-presence', ({ onlineIds }) => {
      const set = new Set(onlineIds || []);
      for (const u of state.dmUsers) u.online = set.has(u.id);
      renderDmUsers();
    });
    socket.on('dm-message', (msg) => {
      handleIncomingDm(msg);
    });
    socket.on('dm-unread', (payload) => {
      if (!payload) return;
      const u = state.dmUsers.find((x) => x.id === payload.otherId);
      if (u) u.unread = payload.unread || 0;
      if (typeof payload.totalUnread === 'number') state.dmTotalUnread = payload.totalUnread;
      updateDmBadge();
      renderDmUsers();
    });
    socket.on('connect_error', (err) => {
      if (err && /unauthorized/i.test(String(err.message || err))) {
        toast('Сессия истекла — войдите снова');
        logout();
      }
    });
    socket.on('disconnect', () => toast('Соединение потеряно…'));
    socket.on('connect', () => {
      if (state.roomId) {
        socket.emit('join-room', { roomId: state.roomId }, (res) => {
          if (res && res.ok) applyJoin(res);
        });
      }
      refreshDmUsers();
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
  const SHAPE_TYPES = new Set([
    'rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event', 'sticky', 'roomLink', 'cardLink', 'image',
    'dbTable', 'dbView', 'dbSchema', 'dbDatabase', 'dbIndex', 'dbProcedure', 'dbTrigger', 'dbEnum', 'text']);

  function objectRotationRad(obj) {
    const deg = (obj && obj.rotation) || 0;
    return (deg * Math.PI) / 180;
  }

  function rotatePoint(px, py, cx, cy, rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - cx;
    const dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  function worldToLocal(obj, wx, wy) {
    const b = boundsOfUnrotated(obj);
    if (!b) return { x: wx, y: wy };
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rad = -objectRotationRad(obj);
    return rotatePoint(wx, wy, cx, cy, rad);
  }

  function centerOf(obj) {
    const b = boundsOfUnrotated(obj) || boundsOf(obj);
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

  const imageCache = new Map(); // src -> HTMLImageElement

  function getCachedImage(src) {
    if (!src) return null;
    let img = imageCache.get(src);
    if (img) return img;
    img = new Image();
    img.decoding = 'async';
    img.onload = () => { if (typeof draw === 'function') draw(); };
    img.onerror = () => { if (typeof draw === 'function') draw(); };
    img.src = src;
    imageCache.set(src, img);
    return img;
  }



  const DB_COLUMN_TYPES = ['dbTable', 'dbView', 'dbEnum'];

  function parseAttrsToColumns(raw) {
    const lines = String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.map((line) => {
      // formats: "id  PK", "name varchar", "id:uuid PK"
      let name = line;
      let type = '';
      let pk = false;
      let unique = false;
      let nullable = true;
      if (/\bPK\b/i.test(line)) { pk = true; nullable = false; }
      if (/\bUQ\b|\bUNIQUE\b/i.test(line)) unique = true;
      if (/\bNOT\s*NULL\b/i.test(line)) nullable = false;
      const cleaned = line.replace(/\b(PK|FK|UQ|UNIQUE|NOT\s*NULL)\b/gi, '').trim();
      const m = cleaned.match(/^([A-Za-z0-9_]+)\s*[:\s]\s*([A-Za-z0-9_()\s]+)$/) || cleaned.match(/^([A-Za-z0-9_]+)$/);
      if (m) {
        name = m[1];
        type = (m[2] || (pk ? 'uuid' : 'text')).trim();
      }
      return { name, type: type || 'text', pk, unique, nullable };
    });
  }


  let dbColumnsEditId = null;

  function syncDbColumnsFromDom(obj) {
    if (!obj) return;
    const nameInput = $('#db-columns-name');
    if (nameInput) obj.label = nameInput.value.trim();
    const body = $('#db-columns-body');
    if (!body) return;
    const rows = [...body.querySelectorAll('tr')];
    const next = [];
    rows.forEach((tr) => {
      const nameEl = tr.querySelector('input[data-f="name"]');
      const typeEl = tr.querySelector('input[data-f="type"]');
      if (!nameEl && !typeEl) return;
      const prev = obj.columns && obj.columns[next.length] ? obj.columns[next.length] : {};
      next.push({
        name: (nameEl && nameEl.value) || '',
        type: (typeEl && typeEl.value) || 'text',
        pk: !!prev.pk,
        unique: !!prev.unique,
        nullable: prev.nullable !== false,
      });
    });
    obj.columns = next;
    ensureDbColumns(obj);
  }

  function openDbColumnsPanel(obj) {
    if (!obj || !DB_COLUMN_TYPES.includes(obj.type)) return;
    cancelInlineEdit(true);
    pendingInlineEditId = null;
    ensureDbColumns(obj);
    if (!Array.isArray(obj.columns) || obj.columns.length === 0) {
      obj.columns = [{ name: '', type: 'text', pk: false, unique: false, nullable: true }];
      ensureDbColumns(obj);
    }
    dbColumnsEditId = obj.id;
    const panel = $('#db-columns-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    const title = $('#db-columns-title');
    if (title) title.textContent = (DB_META[obj.type] && DB_META[obj.type].title) || 'Колонки';
    const nameInput = $('#db-columns-name');
    if (nameInput) nameInput.value = obj.label || obj.name || '';
    const body = $('#db-columns-body');
    if (!body) return;

    const applyField = (inp) => {
      const o2 = state.objects.find((x) => x.id === dbColumnsEditId);
      if (!o2) return;
      ensureDbColumns(o2);
      const i = Number(inp.dataset.i);
      if (!o2.columns[i]) return;
      o2.columns[i][inp.dataset.f] = inp.value;
      if (nameInput) o2.label = nameInput.value.trim();
      ensureDbColumns(o2);
      fitDbHeight(o2);
      emit('object-update', o2);
      draw();
    };

    const redraw = () => {
      const o = state.objects.find((x) => x.id === dbColumnsEditId);
      if (!o) return;
      ensureDbColumns(o);
      body.innerHTML = '';
      o.columns.forEach((col, idx) => {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td');
        const typeTd = document.createElement('td');
        const delTd = document.createElement('td');
        const nameInp = document.createElement('input');
        nameInp.type = 'text';
        nameInp.dataset.f = 'name';
        nameInp.dataset.i = String(idx);
        nameInp.value = col.name || '';
        nameInp.placeholder = 'колонка';
        nameInp.autocomplete = 'off';
        const typeInp = document.createElement('input');
        typeInp.type = 'text';
        typeInp.dataset.f = 'type';
        typeInp.dataset.i = String(idx);
        typeInp.value = col.type || '';
        typeInp.placeholder = 'тип';
        typeInp.autocomplete = 'off';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'db-col-del';
        delBtn.dataset.del = String(idx);
        delBtn.title = 'Удалить строку';
        delBtn.textContent = '✕';
        nameTd.appendChild(nameInp);
        typeTd.appendChild(typeInp);
        delTd.appendChild(delBtn);
        tr.appendChild(nameTd);
        tr.appendChild(typeTd);
        tr.appendChild(delTd);
        body.appendChild(tr);
      });
      body.querySelectorAll('input').forEach((inp) => {
        inp.addEventListener('input', () => applyField(inp));
        inp.addEventListener('change', () => applyField(inp));
        inp.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          e.stopPropagation();
          applyField(inp);
          const i = Number(inp.dataset.i);
          const f = inp.dataset.f;
          const o2 = state.objects.find((x) => x.id === dbColumnsEditId);
          if (!o2) return;
          if (e.shiftKey) {
            if (f === 'type') body.querySelector(`input[data-f="name"][data-i="${i}"]`)?.focus();
            else if (i > 0) body.querySelector(`input[data-f="type"][data-i="${i - 1}"]`)?.focus();
            return;
          }
          if (f === 'name') {
            body.querySelector(`input[data-f="type"][data-i="${i}"]`)?.focus();
          } else {
            ensureDbColumns(o2);
            if (i >= o2.columns.length - 1) {
              pushHistory();
              o2.columns.push({ name: '', type: 'text', pk: false, unique: false, nullable: true });
              fitDbHeight(o2);
              emit('object-update', o2);
              redraw();
              draw();
            }
            requestAnimationFrame(() => {
              body.querySelector(`input[data-f="name"][data-i="${i + 1}"]`)?.focus();
            });
          }
        });
      });
      body.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const o2 = state.objects.find((x) => x.id === dbColumnsEditId);
          if (!o2) return;
          pushHistory();
          syncDbColumnsFromDom(o2);
          ensureDbColumns(o2);
          o2.columns.splice(Number(btn.getAttribute('data-del')), 1);
          if (!o2.columns.length) {
            o2.columns.push({ name: '', type: 'text', pk: false, unique: false, nullable: true });
          }
          fitDbHeight(o2);
          emit('object-update', o2);
          redraw();
          draw();
        });
      });
    };
    redraw();
    requestAnimationFrame(() => {
      const inputs = [...body.querySelectorAll('input[data-f="name"]')];
      const firstEmpty = inputs.find((el) => !el.value.trim()) || inputs[0];
      if (firstEmpty) firstEmpty.focus();
      else if (nameInput) nameInput.focus();
    });
  }

  $('#db-columns-close')?.addEventListener('click', () => {
    const o = state.objects.find((x) => x.id === dbColumnsEditId);
    if (o) {
      pushHistory();
      syncDbColumnsFromDom(o);
      fitDbHeight(o);
      emit('object-update', o);
      draw();
    }
    closeDbColumnsPanel();
    setTool('select');
  });
  $('#db-columns-add')?.addEventListener('click', () => {
    const o = state.objects.find((x) => x.id === dbColumnsEditId);
    if (!o) return;
    pushHistory();
    syncDbColumnsFromDom(o);
    ensureDbColumns(o);
    o.columns.push({ name: '', type: 'text', pk: false, unique: false, nullable: true });
    fitDbHeight(o);
    emit('object-update', o);
    openDbColumnsPanel(o);
    draw();
    requestAnimationFrame(() => {
      const body = $('#db-columns-body');
      const last = body && body.querySelector(`input[data-f="name"][data-i="${o.columns.length - 1}"]`);
      if (last) last.focus();
    });
  });
  $('#db-columns-save')?.addEventListener('click', () => {
    const o = state.objects.find((x) => x.id === dbColumnsEditId);
    if (o) {
      pushHistory();
      syncDbColumnsFromDom(o);
      fitDbHeight(o);
      emit('object-update', o);
      draw();
    }
    closeDbColumnsPanel();
    setTool('select');
  });

  if (true) {
    const nameInput = $('#db-columns-name');
    if (nameInput) {
      nameInput.addEventListener('input', () => {
        const o = state.objects.find((x) => x.id === dbColumnsEditId);
        if (!o) return;
        o.label = nameInput.value.trim();
        emit('object-update', o);
        draw();
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const body = $('#db-columns-body');
        const first = body && body.querySelector('input[data-f="name"]');
        if (first) first.focus();
      });
    }
  }

  function ensureDbColumns(obj) {
    if (!obj || !DB_TYPES.has(obj.type)) return obj;
    if (!Array.isArray(obj.columns)) {
      const raw = obj.text || obj.attrs || '';
      if (raw) obj.columns = parseAttrsToColumns(raw);
      else if (DB_COLUMN_TYPES.includes(obj.type)) {
        const meta = DB_META[obj.type];
        obj.columns = parseAttrsToColumns(meta && meta.defaultAttrs);
      } else {
        obj.columns = [];
      }
    }
    // keep text in sync for older clients
    obj.text = (obj.columns || []).map((c) => {
      let s = `${c.name || ''}${c.type ? ' ' + c.type : ''}`;
      if (c.pk) s += ' PK';
      if (c.unique) s += ' UQ';
      return s.trim();
    }).join('\n');
    return obj;
  }

  function fitDbHeight(obj) {
    if (!obj || !DB_TYPES.has(obj.type)) return;
    ensureDbColumns(obj);
    const rows = (obj.columns && obj.columns.length) || 0;
    const headerH = 28;
    const rowH = 22;
    const minH = obj.type === 'dbSchema' || obj.type === 'dbDatabase' ? 80 : 100;
    obj.h = Math.max(minH, headerH + 16 + rows * rowH + 8);
  }

  const DB_META = {
    dbTable: { title: 'Таблица', header: '#0ea5e9', badge: 'TABLE', defaultLabel: 'table_name', defaultAttrs: 'id  PK\ncreated_at' },
    dbView: { title: 'Представление', header: '#8b5cf6', badge: 'VIEW', defaultLabel: 'view_name', defaultAttrs: 'col1\ncol2' },
    dbSchema: { title: 'Схема', header: '#64748b', badge: 'SCHEMA', defaultLabel: 'public', defaultAttrs: '' },
    dbDatabase: { title: 'База данных', header: '#0284c7', badge: 'DB', defaultLabel: 'database', defaultAttrs: '' },
    dbIndex: { title: 'Индекс', header: '#f59e0b', badge: 'INDEX', defaultLabel: 'idx_name', defaultAttrs: 'column' },
    dbProcedure: { title: 'Процедура', header: '#10b981', badge: 'PROC', defaultLabel: 'proc_name', defaultAttrs: 'arg1\nRETURNS void' },
    dbTrigger: { title: 'Триггер', header: '#ef4444', badge: 'TRIG', defaultLabel: 'trg_name', defaultAttrs: 'AFTER INSERT\nON table' },
    dbEnum: { title: 'Тип / Enum', header: '#ec4899', badge: 'ENUM', defaultLabel: 'enum_name', defaultAttrs: 'value1\nvalue2' },
  };

  function dbAttrLines(obj) {
    const raw = (obj && (obj.text || obj.attrs || '')) || '';
    return String(raw).split(/\r?\n/).map((s) => s.trimEnd()).filter((s, i, arr) => s.length || i < arr.length - 1);
  }

  function drawDbEntity(obj) {
    const meta = DB_META[obj.type] || DB_META.dbTable;
    const x = Math.min(obj.x, obj.x + obj.w);
    const y = Math.min(obj.y, obj.y + obj.h);
    const w = Math.abs(obj.w) || 200;
    const h = Math.abs(obj.h) || 120;
    const headerH = Math.min(28, Math.max(22, h * 0.22));
    const primary = meta.header;
    // Column names must stay readable on dark table body; obj.textColor is often
    // the dark palette default (#1f2937) and disappears on the fill.
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#94a3b8';
    const colNameColor = '#f1f5f9';
    const colTypeColor = '#cbd5e1';
    const dashed = obj.type === 'dbView' || obj.type === 'dbSchema';

    ctx.fillStyle = obj.fill || 'rgba(14,165,233,0.08)';
    ctx.strokeStyle = obj.stroke || primary;
    ctx.lineWidth = obj.strokeWidth || 2;
    if (dashed) ctx.setLineDash([7 / Math.max(state.camera.scale, 0.01), 5 / Math.max(state.camera.scale, 0.01)]);
    if (obj.type === 'dbDatabase') {
      // cylinder-ish rounded rect
      drawRoundedRect(x, y, w, h, 18);
    } else if (obj.type === 'dbSchema') {
      drawRoundedRect(x, y, w, h, 10);
    } else {
      drawRoundedRect(x, y, w, h, 8);
    }
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // header bar
    ctx.fillStyle = primary;
    if (obj.type === 'dbDatabase') {
      drawRoundedRect(x + 1, y + 1, w - 2, headerH, 16);
      ctx.fill();
    } else {
      ctx.beginPath();
      const r = 8;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.lineTo(x + w, y + headerH);
      ctx.lineTo(x, y + headerH);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fill();
    }

    // badge
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `700 ${Math.max(9, Math.min(11, headerH - 10))}px Segoe UI, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.badge, x + 10, y + headerH / 2);

    // name
    const name = (obj.label || obj.name || meta.defaultLabel || '').trim() || meta.defaultLabel;
    ctx.fillStyle = '#fff';
    const nameFs = obj.fontSize != null ? Math.min(objectFontSize(obj), headerH - 6) : Math.max(11, Math.min(14, headerH - 8));
    ctx.font = `600 ${nameFs}px Segoe UI, system-ui, sans-serif`;
    const badgeW = ctx.measureText(meta.badge).width + 16;
    let drawn = name;
    const maxNameW = w - badgeW - 16;
    while (drawn.length > 1 && ctx.measureText(drawn).width > maxNameW) drawn = drawn.slice(0, -1);
    if (drawn !== name && drawn.length > 1) drawn = drawn.slice(0, -1) + '…';
    ctx.fillText(drawn, x + 8 + badgeW, y + headerH / 2);

    // body: name | type columns
    ensureDbColumns(obj);
    const cols = Array.isArray(obj.columns) ? obj.columns : [];
    if (cols.length && obj.type !== 'dbSchema' && obj.type !== 'dbDatabase') {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const bodyFs = Math.max(10, Math.min(12, (obj.fontSize != null ? objectFontSize(obj) : 12) - 1));
      const lh = Math.round(bodyFs * 1.35);
      let yy = y + headerH + 8;
      const splitX = x + Math.floor(w * 0.55);
      for (const col of cols) {
        if (yy + lh > y + h - 4) break;
        const isKey = !!(col.pk || col.unique);
        ctx.fillStyle = isKey ? '#7dd3fc' : colNameColor;
        ctx.font = `${isKey ? '600 ' : ''}${bodyFs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
        let n = String(col.name || '');
        while (n.length > 1 && ctx.measureText(n).width > splitX - x - 14) n = n.slice(0, -1);
        if (n !== String(col.name || '') && n.length > 1) n = n.slice(0, -1) + '…';
        ctx.fillText(n || ' ', x + 10, yy);
        ctx.fillStyle = colTypeColor;
        ctx.font = `${bodyFs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
        let tp = String(col.type || '');
        while (tp.length > 1 && ctx.measureText(tp).width > x + w - splitX - 12) tp = tp.slice(0, -1);
        if (tp !== String(col.type || '') && tp.length > 1) tp = tp.slice(0, -1) + '…';
        ctx.fillText(tp || ' ', splitX, yy);
        yy += lh;
      }
    } else if (obj.type === 'dbSchema' || obj.type === 'dbDatabase') {
      ctx.fillStyle = muted;
      ctx.font = `${Math.max(11, Math.min(12, h * 0.12))}px Segoe UI, system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(meta.title, x + 10, y + headerH + 10);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawObject(obj, { selected = false, hovered = false } = {}) {
    ctx.save();
    ctx.lineWidth = obj.strokeWidth || 2;
    ctx.strokeStyle = obj.stroke || '#1f2937';
    ctx.fillStyle = obj.fill || 'transparent';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const type = obj.type === 'square' ? 'rect' : obj.type;
    const unrot = boundsOfUnrotated(obj);
    const canRotate = ROTATABLE_TYPES.has(obj.type) && (obj.rotation || 0) && unrot;
    if (canRotate) {
      const cx = unrot.x + unrot.w / 2;
      const cy = unrot.y + unrot.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(objectRotationRad(obj));
      ctx.translate(-cx, -cy);
    }

    if (DB_TYPES.has(obj.type)) {
      drawDbEntity(obj);
    } else if (obj.type === 'pen' && obj.points && obj.points.length) {
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
        ctx.fillStyle = objectTextColor(obj);
        ctx.font = `${objectFontSize(obj)}px Segoe UI, system-ui, sans-serif`;
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
        ctx.fillStyle = objectTextColor(obj);
        ctx.font = `${objectFontSize(obj)}px Segoe UI, system-ui, sans-serif`;
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
        ctx.fillStyle = objectTextColor(obj);
        ctx.font = `${objectFontSize(obj)}px Segoe UI, system-ui, sans-serif`;
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
        ctx.fillStyle = objectTextColor(obj);
        ctx.font = `${objectFontSize(obj)}px Segoe UI, system-ui, sans-serif`;
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
      const arrowLabel = (obj.label || '').trim();
      const editingThis = state.inlineEdit && state.inlineEdit.id === obj.id;
      if (arrowLabel && !editingThis) {
        const mx = (obj.x1 + obj.x2) / 2;
        const my = (obj.y1 + obj.y2) / 2;
        const adx = obj.x2 - obj.x1;
        const ady = obj.y2 - obj.y1;
        const alen = Math.hypot(adx, ady) || 1;
        // slight offset perpendicular "above" the segment
        const off = 12;
        const lx = mx + (-ady / alen) * off;
        const ly = my + (adx / alen) * off;
        ctx.fillStyle = objectTextColor(obj);
        ctx.font = `${objectFontSize(obj)}px Segoe UI, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(arrowLabel, lx, ly);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    } else if (obj.type === 'roomLink') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      const w = Math.abs(obj.w) || 180;
      const h = Math.abs(obj.h) || 72;
      const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#3b82f6';
      const textCol = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eef7';
      const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8b9bb4';
      ctx.fillStyle = obj.fill || 'rgba(59,130,246,0.14)';
      ctx.strokeStyle = obj.stroke || primary;
      ctx.lineWidth = obj.strokeWidth || 2;
      drawRoundedRect(x, y, w, h, 14);
      ctx.fill();
      ctx.stroke();
      // badge
      const badgeH = Math.min(22, h * 0.32);
      const badgeW = Math.min(88, w * 0.45);
      ctx.fillStyle = primary;
      drawRoundedRect(x + 10, y + 10, badgeW, badgeH, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.max(10, Math.min(11, badgeH - 6))}px Segoe UI, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('→ комната', x + 10 + badgeW / 2, y + 10 + badgeH / 2);
      // title + room id
      const title = roomLinkTitle(obj);
      const rid = normalizeRoomCode(obj.roomId);
      ctx.textAlign = 'left';
      ctx.fillStyle = obj.textColor || textCol;
      const titleFs = obj.fontSize != null ? objectFontSize(obj) : Math.max(12, Math.min(14, h * 0.2));
      ctx.font = `600 ${titleFs}px Segoe UI, system-ui, sans-serif`;
      const titleY = y + 10 + badgeH + 16;
      const maxTitleW = w - 20;
      let drawnTitle = title;
      while (drawnTitle.length > 1 && ctx.measureText(drawnTitle).width > maxTitleW) {
        drawnTitle = drawnTitle.slice(0, -1);
      }
      if (drawnTitle !== title && drawnTitle.length > 1) drawnTitle = drawnTitle.slice(0, -1) + '…';
      ctx.fillText(drawnTitle, x + 10, titleY);
      ctx.fillStyle = muted;
      ctx.font = `${Math.max(11, Math.min(12, h * 0.16))}px Segoe UI, system-ui, sans-serif`;
      const sub = rid ? `комната: ${rid}` : 'код не задан';
      ctx.fillText(sub, x + 10, titleY + 16);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    } else if (obj.type === 'cardLink') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      const w = Math.abs(obj.w) || 160;
      const h = Math.abs(obj.h) || 100;
      const accent = '#22c55e';
      const textCol = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eef7';
      const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8b9bb4';
      ctx.fillStyle = obj.fill || 'rgba(34,197,94,0.08)';
      ctx.strokeStyle = obj.stroke || accent;
      ctx.lineWidth = obj.strokeWidth || 2;
      ctx.setLineDash([8 / Math.max(state.camera.scale, 0.01), 6 / Math.max(state.camera.scale, 0.01)]);
      drawRoundedRect(x, y, w, h, 12);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      // header bar
      const headerH = Math.min(28, Math.max(22, h * 0.22));
      ctx.fillStyle = 'rgba(34,197,94,0.18)';
      drawRoundedRect(x + 1, y + 1, w - 2, headerH, 10);
      ctx.fill();
      // inset frame feel
      ctx.strokeStyle = 'rgba(34,197,94,0.25)';
      ctx.lineWidth = 1 / Math.max(state.camera.scale, 0.01);
      ctx.strokeRect(x + 6, y + headerH + 4, Math.max(0, w - 12), Math.max(0, h - headerH - 10));
      // title
      const title = cardLinkTitle(obj);
      ctx.fillStyle = obj.textColor || textCol;
      const titleFs = obj.fontSize != null ? objectFontSize(obj) : Math.max(12, Math.min(14, h * 0.16));
      ctx.font = `600 ${titleFs}px Segoe UI, system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const maxTitleW = w - 36;
      let drawnTitle = '📋 ' + title;
      while (drawnTitle.length > 3 && ctx.measureText(drawnTitle).width > maxTitleW) {
        drawnTitle = drawnTitle.slice(0, -1);
      }
      if (drawnTitle !== ('📋 ' + title) && drawnTitle.length > 4) drawnTitle = drawnTitle.slice(0, -1) + '…';
      ctx.fillText(drawnTitle, x + 10, y + headerH / 2 + 1);
      ctx.fillStyle = muted;
      ctx.font = `${Math.max(10, Math.min(11, h * 0.12))}px Segoe UI, system-ui, sans-serif`;
      const boardLabel = obj.cardBoard === 'room' ? 'комната' : 'личная';
      const sub = obj.cardId ? `канбан · ${boardLabel}` : 'задача не привязана';
      ctx.fillText(sub, x + 10, y + headerH + 16);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    } else if (obj.type === 'image') {
      const x = Math.min(obj.x, obj.x + obj.w);
      const y = Math.min(obj.y, obj.y + obj.h);
      const w = Math.abs(obj.w) || 1;
      const h = Math.abs(obj.h) || 1;
      const img = getCachedImage(obj.src);
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, x, y, w, h);
      } else {
        ctx.fillStyle = 'rgba(148,163,184,0.35)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(100,116,139,0.7)';
        ctx.lineWidth = 1 / state.camera.scale;
        ctx.strokeRect(x, y, w, h);
      }
    } else if (obj.type === 'sticky') {
      const w = obj.w || 160;
      const h = obj.h || 120;
      const fs = objectFontSize(obj);
      ctx.fillStyle = obj.fill || '#fef08a';
      ctx.strokeStyle = 'rgba(0,0,0,.15)';
      drawRoundedRect(obj.x, obj.y, w, h, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = objectTextColor(obj);
      ctx.font = `${fs}px Segoe UI, system-ui, sans-serif`;
      wrapText(ctx, obj.text || '', obj.x + 10, obj.y + Math.max(18, fs + 6), w - 20, Math.round(fs * 1.25));
    } else if (obj.type === 'text') {
      const fs = objectFontSize(obj);
      const tw = Math.max(40, obj.w || 160);
      const th = Math.max(fs * 1.2, obj.h || fs * 1.4);
      if (obj.w == null) obj.w = tw;
      if (obj.h == null) obj.h = th;
      ctx.fillStyle = objectTextColor(obj);
      ctx.font = `${fs}px Segoe UI, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      wrapText(ctx, obj.text || '', obj.x, obj.y, tw, Math.round(fs * 1.25));
      ctx.textBaseline = 'alphabetic';
    }

    if (selected || hovered) {
      const b = unrot || boundsOfUnrotated(obj) || boundsOf(obj);
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
          if (SHAPE_TYPES.has(obj.type) || obj.type === 'text') {
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
          if (ROTATABLE_TYPES.has(obj.type)) {
            const cx = b.x + b.w / 2;
            const topY = b.y - 4;
            const handleY = topY - 18 / state.camera.scale;
            ctx.beginPath();
            ctx.moveTo(cx, topY);
            ctx.lineTo(cx, handleY);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, handleY, 5 / state.camera.scale, 0, Math.PI * 2);
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
          }
        }
        if (DB_COLUMN_TYPES.includes(obj.type) && (selected || hovered)) {
          drawDbSettingsButton(obj, { active: selected });
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

  function boundsOfUnrotated(obj) {
    if (!obj) return null;
    if (obj.type === 'pen' && obj.points && obj.points.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of obj.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
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
      const fs = objectFontSize(obj);
      const w = Math.max(40, obj.w || 160);
      const h = Math.max(fs * 1.2, obj.h || fs * 1.4);
      return { x: obj.x, y: obj.y, w, h };
    }
    return null;
  }

  function boundsOf(obj) {
    const b = boundsOfUnrotated(obj);
    if (!b) return null;
    const rot = (obj.rotation || 0) % 360;
    if (!rot || !ROTATABLE_TYPES.has(obj.type)) return b;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rad = objectRotationRad(obj);
    const corners = [
      rotatePoint(b.x, b.y, cx, cy, rad),
      rotatePoint(b.x + b.w, b.y, cx, cy, rad),
      rotatePoint(b.x, b.y + b.h, cx, cy, rad),
      rotatePoint(b.x + b.w, b.y + b.h, cx, cy, rad),
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }


  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function segmentIntersectsRect(x1, y1, x2, y2, r) {
    if (pointInRect(x1, y1, r) || pointInRect(x2, y2, r)) return true;
    // Liang-Barsky / edge checks via bbox of segment vs rect already partial;
    // also test if segment crosses any edge of the rect
    const edges = [
      [r.x, r.y, r.x + r.w, r.y],
      [r.x, r.y + r.h, r.x + r.w, r.y + r.h],
      [r.x, r.y, r.x, r.y + r.h],
      [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
    ];
    const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const onSeg = (ax, ay, bx, by, cx, cy) => (
      Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) &&
      Math.min(ay, by) <= cy && cy <= Math.max(ay, by)
    );
    const crosses = (ax, ay, bx, by, cx, cy, dx, dy) => {
      const o1 = orient(ax, ay, bx, by, cx, cy);
      const o2 = orient(ax, ay, bx, by, dx, dy);
      const o3 = orient(cx, cy, dx, dy, ax, ay);
      const o4 = orient(cx, cy, dx, dy, bx, by);
      if (o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
      if (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
      if (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
      if (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
      return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
    };
    for (const [ex1, ey1, ex2, ey2] of edges) {
      if (crosses(x1, y1, x2, y2, ex1, ey1, ex2, ey2)) return true;
    }
    return false;
  }

  function applyMarqueeSelection(m) {
    const r = {
      x: Math.min(m.x1, m.x2),
      y: Math.min(m.y1, m.y2),
      w: Math.abs(m.x2 - m.x1),
      h: Math.abs(m.y2 - m.y1),
    };
    if (r.w < 2 && r.h < 2) {
      // tiny drag = click: clear unless additive
      if (!m.additive) {
        state.selectedIds.clear();
        state.selectedConnectorIds.clear();
      }
      return;
    }
    if (!m.additive) {
      state.selectedIds.clear();
      state.selectedConnectorIds.clear();
    }
    for (const obj of state.objects) {
      const b = boundsOf(obj);
      if (b && rectsIntersect(b, r)) state.selectedIds.add(obj.id);
    }
    for (const conn of state.connectors) {
      const ep = connectorEndpoints(conn);
      if (!ep) continue;
      if (segmentIntersectsRect(ep.x1, ep.y1, ep.x2, ep.y2, r)) {
        state.selectedConnectorIds.add(conn.id);
      }
    }
  }

  function hitTest(wx, wy) {
    let cardLinkHit = null;
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const obj = state.objects[i];
      const b = boundsOfUnrotated(obj);
      if (!b) continue;
      const pad = 6 / state.camera.scale;
      let lx = wx, ly = wy;
      if (ROTATABLE_TYPES.has(obj.type) && (obj.rotation || 0)) {
        const local = worldToLocal(obj, wx, wy);
        lx = local.x; ly = local.y;
      }
      if (lx >= b.x - pad && lx <= b.x + b.w + pad && ly >= b.y - pad && ly <= b.y + b.h + pad) {
        if (obj.type === 'cardLink') {
          if (!cardLinkHit) cardLinkHit = obj;
          continue;
        }
        return obj;
      }
    }
    return cardLinkHit;
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
    if (!SHAPE_TYPES.has(obj.type) && obj.type !== 'text') return null;
    const b = boundsOfUnrotated(obj);
    if (!b) return null;
    let lx = wx, ly = wy;
    if (ROTATABLE_TYPES.has(obj.type) && (obj.rotation || 0)) {
      const local = worldToLocal(obj, wx, wy);
      lx = local.x; ly = local.y;
    }
    const hs = 8 / state.camera.scale;
    const handles = [
      { corner: 'nw', x: b.x, y: b.y },
      { corner: 'ne', x: b.x + b.w, y: b.y },
      { corner: 'sw', x: b.x, y: b.y + b.h },
      { corner: 'se', x: b.x + b.w, y: b.y + b.h },
    ];
    for (const h of handles) {
      if (Math.abs(lx - h.x) <= hs && Math.abs(ly - h.y) <= hs) return h.corner;
    }
    return null;
  }

  function hitRotationHandle(obj, wx, wy) {
    if (!obj || !ROTATABLE_TYPES.has(obj.type)) return false;
    const b = boundsOfUnrotated(obj);
    if (!b) return false;
    let lx = wx, ly = wy;
    if (obj.rotation || 0) {
      const local = worldToLocal(obj, wx, wy);
      lx = local.x; ly = local.y;
    }
    const cx = b.x + b.w / 2;
    const handleY = b.y - 4 - 18 / state.camera.scale;
    const hs = 10 / state.camera.scale;
    return Math.hypot(lx - cx, ly - handleY) <= hs;
  }

  function dbSettingsButtonLocal(obj) {
    if (!obj || !DB_COLUMN_TYPES.includes(obj.type)) return null;
    const b = boundsOfUnrotated(obj);
    if (!b) return null;
    const size = Math.max(16 / state.camera.scale, Math.min(22 / state.camera.scale, b.w * 0.12));
    const pad = 5 / state.camera.scale;
    return {
      x: b.x + b.w - size - pad,
      y: b.y + pad,
      size,
      cx: b.x + b.w - size / 2 - pad,
      cy: b.y + pad + size / 2,
    };
  }

  function hitDbSettingsButton(obj, wx, wy) {
    const btn = dbSettingsButtonLocal(obj);
    if (!btn) return false;
    let lx = wx, ly = wy;
    if (ROTATABLE_TYPES.has(obj.type) && (obj.rotation || 0)) {
      const local = worldToLocal(obj, wx, wy);
      lx = local.x; ly = local.y;
    }
    return lx >= btn.x && lx <= btn.x + btn.size && ly >= btn.y && ly <= btn.y + btn.size;
  }

  function findDbSettingsHit(wx, wy) {
    const seen = new Set();
    const candidates = [];
    const push = (o) => {
      if (!o || seen.has(o.id) || !DB_COLUMN_TYPES.includes(o.type)) return;
      seen.add(o.id);
      candidates.push(o);
    };
    if (state.selectedIds.size === 1) {
      push(state.objects.find((o) => o.id === [...state.selectedIds][0]));
    }
    if (state.hoverId) push(state.objects.find((o) => o.id === state.hoverId));
    push(hitTest(wx, wy));
    for (const obj of candidates) {
      if (hitDbSettingsButton(obj, wx, wy)) return obj;
    }
    return null;
  }

  function drawDbSettingsButton(obj, { active = false } = {}) {
    const btn = dbSettingsButtonLocal(obj);
    if (!btn) return;
    const { cx, cy, size } = btn;
    const r = size / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = active ? 'rgba(14,165,233,0.95)' : 'rgba(15,23,42,0.72)';
    ctx.fill();
    ctx.strokeStyle = active ? '#7dd3fc' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2 / state.camera.scale;
    ctx.stroke();
    // simple gear: hub + teeth
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1.4 / state.camera.scale;
    const teeth = 8;
    const outer = r * 0.72;
    const inner = r * 0.42;
    const hub = r * 0.22;
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, hub, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
    for (const p of (state.pendingPens || [])) drawObject(p, {});
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
    if (state.marquee) {
      const m = state.marquee;
      const x = Math.min(m.x1, m.x2);
      const y = Math.min(m.y1, m.y2);
      const w = Math.abs(m.x2 - m.x1);
      const h = Math.abs(m.y2 - m.y1);
      ctx.save();
      ctx.fillStyle = 'rgba(59,130,246,0.12)';
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1 / state.camera.scale;
      ctx.setLineDash([6 / state.camera.scale, 4 / state.camera.scale]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
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
    let objIds = [...state.selectedIds];
    const connIds = [...state.selectedConnectorIds];
    if (!objIds.length && !connIds.length) return;
    pushHistory();

    if (objIds.length) {
      const cardLinkIds = objIds.filter((id) => {
        const o = state.objects.find((x) => x.id === id);
        return o && o.type === 'cardLink';
      });
      if (cardLinkIds.length) {
        const ok = window.confirm('Удалить контейнер задачи? Вложенные фигуры останутся на холсте.');
        if (!ok) return;
        const keepChildren = new Set();
        for (const obj of state.objects) {
          if (obj.parentId && cardLinkIds.includes(obj.parentId)) {
            keepChildren.add(obj.id);
            obj.parentId = null;
            emit('object-update', obj);
          }
        }
        objIds = objIds.filter((id) => !keepChildren.has(id));
        if (!objIds.length && !connIds.length) {
          draw();
          return;
        }
      }
      const delSet = new Set(objIds);
      state.objects = state.objects.filter((o) => !delSet.has(o.id));
      const orphaned = state.connectors.filter(
        (c) => delSet.has(c.fromId) || delSet.has(c.toId)
      );
      state.connectors = state.connectors.filter(
        (c) => !delSet.has(c.fromId) && !delSet.has(c.toId)
      );
      for (const id of objIds) state.selectedIds.delete(id);
      if (objIds.length) emit('object-delete', { ids: objIds });
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


  function normalizeRoomCode(code) {
    return String(code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  }

  function roomLinkTitle(obj) {
    const label = (obj.label || obj.text || '').trim();
    if (label) return label;
    const rid = normalizeRoomCode(obj.roomId);
    return rid ? `→ ${rid}` : 'Ссылка на комнату';
  }

  function cardsForBoard(board) {
    return board === 'room' ? state.cards : state.personalCards;
  }

  function columnsForBoard(board) {
    return board === 'personal' ? state.personalColumns : state.columns;
  }

  function findCardOnBoard(cardId, board) {
    if (!cardId) return null;
    return cardsForBoard(board === 'room' ? 'room' : 'personal').find((c) => c.id === cardId) || null;
  }

  function cardLinkTitle(obj) {
    if (!obj) return 'Задача';
    const label = (obj.label || '').trim();
    if (label) return label;
    const board = obj.cardBoard === 'room' ? 'room' : 'personal';
    const card = findCardOnBoard(obj.cardId, board);
    if (card && card.title) return card.title;
    return 'Задача';
  }

  function fillCardLinkCardSelect(board, selectedId) {
    const sel = $('#card-link-card');
    if (!sel) return;
    const cards = [...cardsForBoard(board)].sort((a, b) =>
      String(a.title || '').localeCompare(String(b.title || ''), 'ru')
    );
    const cur = selectedId || '';
    sel.innerHTML = '<option value="">— не выбрана —</option>' + cards.map((c) => {
      const title = escapeHtml(c.title || 'Без названия');
      const selected = c.id === cur ? ' selected' : '';
      return `<option value="${c.id}"${selected}>${title}</option>`;
    }).join('');
  }

  function openCardLinkPanel(obj) {
    if (!obj || obj.type !== 'cardLink') return;
    cancelInlineEdit(true);
    closeRoomLinkPanel();
    state.editingCardLinkId = obj.id;
    const board = obj.cardBoard === 'room' ? 'room' : (obj.cardBoard === 'personal' ? 'personal' : (state.kanbanMode || 'personal'));
    $('#card-link-board').value = board;
    $('#card-link-label').value = obj.label || '';
    fillCardLinkCardSelect(board, obj.cardId || '');
    cardLinkPanel.classList.remove('hidden');
    const labelInput = $('#card-link-label');
    labelInput.focus();
    labelInput.select();
  }

  function closeCardLinkPanel() {
    state.editingCardLinkId = null;
    cardLinkPanel.classList.add('hidden');
  }

  function saveCardLinkPanel() {
    if (!state.editingCardLinkId) return null;
    const obj = state.objects.find((o) => o.id === state.editingCardLinkId);
    if (!obj) {
      closeCardLinkPanel();
      return null;
    }
    const board = $('#card-link-board').value === 'room' ? 'room' : 'personal';
    const cardId = String($('#card-link-card').value || '').trim() || null;
    const label = String($('#card-link-label').value || '').trim().slice(0, 80);
    obj.cardBoard = board;
    obj.cardId = cardId;
    obj.label = label;
    emit('object-update', obj);
    draw();
    return obj;
  }

  function navigateCardLink(obj) {
    if (!obj || obj.type !== 'cardLink') return;
    if (!obj.cardId) {
      toast('Сначала привяжите карточку канбана');
      openCardLinkPanel(obj);
      return;
    }
    const board = obj.cardBoard === 'room' ? 'room' : 'personal';
    closeCardLinkPanel();
    setView('kanban', { kanbanMode: board });
    // open after view switch so activeCards() sees the right board
    requestAnimationFrame(() => openCardPanel(obj.cardId));
  }

  function emitCardAddOnBoard(board, data, ack) {
    const event = board === 'personal' ? 'personal-card-add' : 'card-add';
    emit(event, data, ack);
  }

  function createCardForCardLink() {
    if (!state.editingCardLinkId) return;
    const obj = state.objects.find((o) => o.id === state.editingCardLinkId);
    if (!obj) return;
    const board = $('#card-link-board').value === 'room' ? 'room' : 'personal';
    const cols = [...columnsForBoard(board)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!cols.length) {
      toast('На доске нет колонок');
      return;
    }
    const title = String($('#card-link-label').value || '').trim() || 'Новая карточка';
    const columnId = cols[0].id;
    const order = cardsForBoard(board).filter((c) => c.columnId === columnId).length;
    emitCardAddOnBoard(board, {
      columnId,
      title,
      description: '',
      dueDate: null,
      order,
    }, (res) => {
      if (!res || !res.ok || !res.card) {
        toast((res && res.error) || 'Не удалось создать карточку');
        return;
      }
      // ensure local list has the card (socket may also deliver)
      const list = board === 'room' ? state.cards : state.personalCards;
      if (!list.find((c) => c.id === res.card.id)) list.push(res.card);
      obj.cardBoard = board;
      obj.cardId = res.card.id;
      if (!(obj.label || '').trim()) obj.label = res.card.title || '';
      $('#card-link-label').value = obj.label || '';
      fillCardLinkCardSelect(board, obj.cardId);
      emit('object-update', obj);
      draw();
      toast('Карточка создана и привязана');
    });
  }

  function childrenOfCardLink(cardLinkId) {
    return state.objects.filter((o) => o.parentId === cardLinkId);
  }

  function expandDragIdsWithChildren(ids) {
    const out = new Set(ids);
    for (const id of ids) {
      const o = state.objects.find((x) => x.id === id);
      if (o && o.type === 'cardLink') {
        for (const ch of childrenOfCardLink(id)) out.add(ch.id);
      }
    }
    return [...out];
  }

  function findCardLinkAtPoint(wx, wy, excludeId) {
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'cardLink' || o.id === excludeId) continue;
      const b = boundsOf(o);
      if (b && pointInRect(wx, wy, b)) return o;
    }
    return null;
  }

  function reparentAfterDrag(movedIds) {
    for (const id of movedIds) {
      const obj = state.objects.find((o) => o.id === id);
      if (!obj) continue;
      if (obj.type === 'cardLink') {
        if (obj.parentId) {
          obj.parentId = null;
          emit('object-update', obj);
        }
        continue;
      }
      const c = centerOf(obj);
      if (!c) continue;
      const host = findCardLinkAtPoint(c.x, c.y, obj.id);
      const newParent = host ? host.id : null;
      if ((obj.parentId || null) !== newParent) {
        obj.parentId = newParent;
        emit('object-update', obj);
      }
    }
  }

  function openRoomLinkPanel(obj) {
    if (!obj || obj.type !== 'roomLink') return;
    cancelInlineEdit(true);
    state.editingRoomLinkId = obj.id;
    $('#room-link-id').value = obj.roomId || '';
    $('#room-link-label').value = obj.label || obj.text || '';
    roomLinkPanel.classList.remove('hidden');
    const idInput = $('#room-link-id');
    idInput.focus();
    idInput.select();
  }

  function closeRoomLinkPanel() {
    state.editingRoomLinkId = null;
    roomLinkPanel.classList.add('hidden');
  }

  function saveRoomLinkPanel() {
    if (!state.editingRoomLinkId) return null;
    const obj = state.objects.find((o) => o.id === state.editingRoomLinkId);
    if (!obj) {
      closeRoomLinkPanel();
      return null;
    }
    const roomId = normalizeRoomCode($('#room-link-id').value);
    const label = String($('#room-link-label').value || '').trim().slice(0, 80);
    obj.roomId = roomId;
    obj.label = label;
    obj.text = label;
    emit('object-update', obj);
    draw();
    return obj;
  }

  function navigateRoomLink(obj) {
    if (!obj || obj.type !== 'roomLink') return;
    const roomId = normalizeRoomCode(obj.roomId);
    if (!roomId) {
      openRoomLinkPanel(obj);
      toast('Укажите код комнаты');
      return;
    }
    if (roomId === state.roomId) {
      toast('Уже в этой комнате');
      return;
    }
    closeRoomLinkPanel();
    upsertTab(roomId);
    enterRoom(roomId, { addTab: true });
  }

  // ---------- Inline edit ----------
  let inlineEditIgnoreBlurUntil = 0;
  let pendingInlineEditId = null;

  function queueInlineEdit(objOrId) {
    const id = typeof objOrId === 'string' ? objOrId : objOrId?.id;
    if (!id) return;
    pendingInlineEditId = id;
  }

  function flushPendingInlineEdit() {
    if (!pendingInlineEditId) return;
    const id = pendingInlineEditId;
    pendingInlineEditId = null;
    const obj = state.objects.find((o) => o.id === id);
    if (obj) startInlineEdit(obj);
  }


  function queueInlineEditAttrs(objOrId) {
    const id = typeof objOrId === 'string' ? objOrId : objOrId?.id;
    if (!id) return;
    pendingInlineEditId = null;
    const obj = state.objects.find((o) => o.id === id);
    if (obj) startInlineEditAttrs(obj);
  }

  function startInlineEditAttrs(obj) {
    if (!obj || !DB_TYPES.has(obj.type)) return;
    if (DB_COLUMN_TYPES.includes(obj.type)) { openDbColumnsPanel(obj); return; }
    cancelInlineEdit(true);
    const b = boundsOfUnrotated(obj) || boundsOf(obj);
    if (!b) return;
    const headerH = Math.min(28, Math.max(22, b.h * 0.22));
    const tl = screenFromWorld(b.x, b.y + headerH);
    const br = screenFromWorld(b.x + b.w, b.y + b.h);
    inlineEditEl.classList.remove('hidden');
    inlineEditEl.classList.add('sticky-edit');
    inlineEditEl.style.left = `${tl.x}px`;
    inlineEditEl.style.top = `${tl.y}px`;
    inlineEditEl.style.width = `${Math.max(80, br.x - tl.x)}px`;
    inlineEditEl.style.height = `${Math.max(40, br.y - tl.y)}px`;
    inlineEditEl.style.fontSize = `${12 * state.camera.scale}px`;
    inlineEditEl.style.color = objectTextColor(obj);
    inlineEditEl.style.background = 'rgba(0,0,0,0.45)';
    inlineEditEl.style.zIndex = '30';
    const initial = obj.text || '';
    inlineEditEl.textContent = initial;
    state.inlineEdit = { id: obj.id, original: initial, field: 'text' };
    inlineEditIgnoreBlurUntil = Date.now() + 200;
    requestAnimationFrame(() => setTimeout(() => {
      if (!state.inlineEdit || state.inlineEdit.id !== obj.id) return;
      inlineEditEl.focus({ preventScroll: true });
    }, 0));
  }

  function startInlineEdit(obj) {
    if (!obj) return;
    const shapeLabelTypes = ['task', 'gateway', 'event', 'rect', 'square', 'circle', 'ellipse', 'arrow', 'line'];
    const isDb = DB_TYPES.has(obj.type);
    const isArrowLike = obj.type === 'arrow' || obj.type === 'line';
    if (obj.type !== 'text' && obj.type !== 'sticky' && !shapeLabelTypes.includes(obj.type) && !isDb) {
      return;
    }
    setColorTarget('text');
    state.textColor = objectTextColor(obj);
    syncFontSizeUI(objectFontSize(obj));
    syncColorUI(state.textColor);
    cancelInlineEdit(true);
    const editFs = objectFontSize(obj);
    let tl, br;
    if (isArrowLike) {
      // Edit box centered on midpoint, slightly above the segment
      const mx = (obj.x1 + obj.x2) / 2;
      const my = (obj.y1 + obj.y2) / 2;
      const adx = obj.x2 - obj.x1;
      const ady = obj.y2 - obj.y1;
      const alen = Math.hypot(adx, ady) || 1;
      const off = 12;
      const lx = mx + (-ady / alen) * off;
      const ly = my + (adx / alen) * off;
      const editW = Math.max(120, Math.min(280, 40 + String(obj.label || '').length * editFs * 0.55));
      const editH = Math.max(28, editFs * 1.5);
      tl = screenFromWorld(lx - editW / 2, ly - editH / 2);
      br = screenFromWorld(lx + editW / 2, ly + editH / 2);
    } else {
      const b = boundsOfUnrotated(obj) || boundsOf(obj);
      if (!b) return;
      const headerH = isDb ? Math.min(28, Math.max(22, b.h * 0.22)) : b.h;
      const editTop = isDb ? b.y : b.y;
      const editH = isDb ? headerH : b.h;
      tl = screenFromWorld(b.x, editTop);
      br = screenFromWorld(b.x + b.w, editTop + editH);
    }
    inlineEditEl.classList.remove('hidden');
    inlineEditEl.classList.toggle('sticky-edit', obj.type === 'sticky' || (isDb && false));
    inlineEditEl.style.left = `${tl.x}px`;
    inlineEditEl.style.top = `${tl.y}px`;
    inlineEditEl.style.width = `${Math.max(80, br.x - tl.x)}px`;
    inlineEditEl.style.height = `${Math.max(isDb ? 24 : 28, br.y - tl.y)}px`;
    inlineEditEl.style.fontSize = `${editFs * state.camera.scale}px`;
    inlineEditEl.style.color = isDb ? '#ffffff' : objectTextColor(obj);
    inlineEditEl.style.background = isDb ? 'rgba(0,0,0,0.35)' : (isArrowLike ? 'rgba(0,0,0,0.55)' : '');
    inlineEditEl.style.zIndex = '30';
    inlineEditEl.style.textAlign = isArrowLike ? 'center' : '';

    const initial = obj.type === 'text' || obj.type === 'sticky'
      ? (obj.text || '')
      : (obj.label || obj.name || '');
    inlineEditEl.textContent = initial;
    state.inlineEdit = {
      id: obj.id,
      original: initial,
      field: (obj.type === 'text' || obj.type === 'sticky') ? 'text' : 'label',
    };
    inlineEditIgnoreBlurUntil = Date.now() + 200;
    // Focus after the current pointer gesture ends so the canvas does not steal it back
    const focusEditor = () => {
      if (!state.inlineEdit || state.inlineEdit.id !== obj.id) return;
      inlineEditEl.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(inlineEditEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    requestAnimationFrame(() => setTimeout(focusEditor, 0));
  }

  function commitInlineEdit() {
    if (!state.inlineEdit) return;
    const { id, field } = state.inlineEdit;
    const value = inlineEditEl.innerText.replace(/\u00a0/g, ' ').trimEnd().slice(0, 500);
    const obj = state.objects.find((o) => o.id === id);
    state.inlineEdit = null;
    inlineEditIgnoreBlurUntil = 0;
    inlineEditEl.classList.add('hidden');
    inlineEditEl.textContent = '';
    inlineEditEl.style.background = '';
    inlineEditEl.style.textAlign = '';
    if (!obj) return;
    if (field === 'text') obj.text = value;
    else obj.label = value;
    emit('object-update', obj);
    // After editing an arrow/line label, return palette to figure/stroke mode
    if (obj.type === 'arrow' || obj.type === 'line') syncColorTargetFromSelection();
    draw();
  }

  function cancelInlineEdit(silent) {
    pendingInlineEditId = null;
    if (!state.inlineEdit) {
      inlineEditEl.classList.add('hidden');
      return;
    }
    state.inlineEdit = null;
    inlineEditIgnoreBlurUntil = 0;
    inlineEditEl.classList.add('hidden');
    inlineEditEl.textContent = '';
    inlineEditEl.style.background = '';
    inlineEditEl.style.textAlign = '';
    if (!silent) draw();
  }

  inlineEditEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  inlineEditEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
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
    if (Date.now() < inlineEditIgnoreBlurUntil) {
      requestAnimationFrame(() => {
        if (state.inlineEdit) inlineEditEl.focus({ preventScroll: true });
      });
      return;
    }
    if (state.inlineEdit) commitInlineEdit();
  });

  function expandRoomLinkToScheme() {
    if (!state.editingRoomLinkId) {
      toast('Ссылка не выбрана');
      return;
    }
    const link = saveRoomLinkPanel() || state.objects.find((o) => o.id === state.editingRoomLinkId);
    if (!link || link.type !== 'roomLink') {
      toast('Ссылка не выбрана');
      return;
    }
    const code = normalizeRoomCode(link.roomId);
    if (!code) {
      toast('Укажите код комнаты');
      return;
    }
    const confirmText = `Развернуть комнату ${code} в текущую схему? Объекты комнаты будут скопированы на этот холст. Ссылка будет удалена. Продолжить?`;
    if (!window.confirm(confirmText)) return;

    emit('room-snapshot', { roomId: code }, (res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || 'Не удалось получить комнату');
        return;
      }
      const srcObjects = Array.isArray(res.objects) ? res.objects : [];
      const srcConnectors = Array.isArray(res.connectors) ? res.connectors : [];
      if (!srcObjects.length && !srcConnectors.length) {
        toast('Комната пуста или не найдена');
        return;
      }

      const ox = typeof link.x === 'number' ? link.x : 0;
      const oy = typeof link.y === 'number' ? link.y : 0;
      const idMap = new Map();
      const newObjs = [];

      for (const src of srcObjects) {
        if (!src || !src.id) continue;
        const orig = JSON.parse(JSON.stringify(src));
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid('obj');
        idMap.set(src.id, copy.id);
        applyDelta(copy, orig, ox, oy);
        newObjs.push(copy);
      }

      // Delete original roomLink shape (and its connectors)
      const linkId = link.id;
      state.objects = state.objects.filter((o) => o.id !== linkId);
      state.connectors = state.connectors.filter(
        (c) => c.fromId !== linkId && c.toId !== linkId
      );
      state.selectedIds.delete(linkId);
      emit('object-delete', { ids: [linkId] });
      closeRoomLinkPanel();

      for (const obj of newObjs) {
        state.objects.push(obj);
        emit('object-add', obj);
      }

      for (const srcConn of srcConnectors) {
        if (!srcConn) continue;
        const fromId = idMap.get(srcConn.fromId);
        const toId = idMap.get(srcConn.toId);
        if (!fromId || !toId || fromId === toId) continue;
        const conn = {
          id: uid('conn'),
          type: 'connector',
          fromId,
          toId,
          stroke: srcConn.stroke || '#64748b',
          strokeWidth: srcConn.strokeWidth || 2,
          arrow: srcConn.arrow !== false,
        };
        if (!state.connectors.find((c) => c.id === conn.id)) {
          state.connectors.push(conn);
        }
        emit('connector-add', conn);
      }

      state.selectedIds = new Set(newObjs.map((o) => o.id));
      state.selectedConnectorIds.clear();
      setTool('select');
      draw();
      toast(newObjs.length
        ? `Развёрнуто: ${newObjs.length} объект(ов)`
        : 'Схема развёрнута');
    });
  }

  $('#room-link-panel-close').addEventListener('click', () => {
    saveRoomLinkPanel();
    closeRoomLinkPanel();
  });
  $('#room-link-save').addEventListener('click', () => {
    const obj = saveRoomLinkPanel();
    closeRoomLinkPanel();
    if (obj && !obj.roomId) toast('Код комнаты пуст — укажите позже');
    else toast('Ссылка сохранена');
  });
  $('#room-link-open').addEventListener('click', () => {
    const obj = saveRoomLinkPanel();
    if (obj) navigateRoomLink(obj);
  });
  $('#room-link-expand').addEventListener('click', () => {
    expandRoomLinkToScheme();
  });
  $('#room-link-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#room-link-save').click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeRoomLinkPanel();
    }
  });
  $('#room-link-label').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#room-link-save').click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeRoomLinkPanel();
    }
  });


  $('#card-link-panel-close').addEventListener('click', () => {
    saveCardLinkPanel();
    closeCardLinkPanel();
  });
  $('#card-link-close-btn').addEventListener('click', () => {
    saveCardLinkPanel();
    closeCardLinkPanel();
  });
  $('#card-link-save').addEventListener('click', () => {
    const obj = saveCardLinkPanel();
    closeCardLinkPanel();
    if (obj && !obj.cardId) toast('Карточка не выбрана — привяжите позже');
    else toast('Ссылка на задачу сохранена');
  });
  $('#card-link-open').addEventListener('click', () => {
    const obj = saveCardLinkPanel();
    if (obj) navigateCardLink(obj);
  });
  $('#card-link-create-card').addEventListener('click', () => {
    createCardForCardLink();
  });
  $('#card-link-board').addEventListener('change', () => {
    const board = $('#card-link-board').value === 'room' ? 'room' : 'personal';
    fillCardLinkCardSelect(board, $('#card-link-card').value || '');
  });
  $('#card-link-label').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#card-link-save').click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCardLinkPanel();
    }
  });
  $('#card-link-card').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCardLinkPanel();
    }
  });

  // ---------- Pointer handlers ----------

  // Middle mouse button: pan the canvas (block browser autoscroll)
  canvasWrap.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  canvasWrap.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  canvasWrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

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
    {
      const _pt = getLocalPoint(e);
      const _w = worldFromScreen(_pt.x, _pt.y);
      state.lastPointerWorld = { x: _w.x, y: _w.y };
    }
    if (e.target === inlineEditEl || inlineEditEl.contains(e.target)) return;
    if (roomLinkPanel.contains(e.target)) return;
    if (cardLinkPanel && cardLinkPanel.contains(e.target)) return;
    const paletteEl = $('#color-palette');
    if (paletteEl && (e.target === paletteEl || paletteEl.contains(e.target))) return;
    if (state.inlineEdit) commitInlineEdit();
    if (!roomLinkPanel.classList.contains('hidden') && state.editingRoomLinkId) {
      saveRoomLinkPanel();
      closeRoomLinkPanel();
    }
    if (cardLinkPanel && !cardLinkPanel.classList.contains('hidden') && state.editingCardLinkId) {
      saveCardLinkPanel();
      closeCardLinkPanel();
    }

    const willPlaceEditable = state.tool === 'sticky' || state.tool === 'text';
    if (!willPlaceEditable) {
      canvasWrap.setPointerCapture(e.pointerId);
    }
    const pt = getLocalPoint(e);
    const world = worldFromScreen(pt.x, pt.y);
    const middle = e.button === 1 || (e.buttons & 4) === 4;
    const panMode = state.tool === 'pan' || state.spaceDown || middle;

    if (panMode) {
      if (middle) e.preventDefault();
      try { canvasWrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      state.panning = { sx: pt.x, sy: pt.y, cx: state.camera.x, cy: state.camera.y, viaMiddle: !!middle };
      canvasWrap.style.cursor = 'grabbing';
      return;
    }

    if (state.tool === 'connector') {
      const hit = hitTest(world.x, world.y);
      const canConnect = hit && (SHAPE_TYPES.has(hit.type) || hit.type === 'text');
      if (!canConnect) {
        toast('Кликните по фигуре');
        return;
      }
      if (!state.connectorFromId) {
        state.connectorFromId = hit.id;
        state.selectedIds = new Set([hit.id]);
        syncColorTargetFromSelection();
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
      syncColorTargetFromSelection();
      connectorHint.textContent = 'Выберите фигуру-источник, затем фигуру-цель';
      draw();
      return;
    }

    if (state.tool === 'select') {
      // DB table settings gear (hover/selected) → columns panel
      if (e.button === 0) {
        const gearObj = findDbSettingsHit(world.x, world.y);
        if (gearObj) {
          e.preventDefault();
          e.stopPropagation();
          state.selectedIds = new Set([gearObj.id]);
          state.selectedConnectorIds.clear();
          syncColorTargetFromSelection();
          openDbColumnsPanel(gearObj);
          draw();
          return;
        }
      }
      // Rectangular marquee: RMB anywhere, or LMB on empty space (below)
      const rightBtn = e.button === 2 || (e.buttons & 2) === 2;
      if (rightBtn) {
        e.preventDefault();
        try { canvasWrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        state.marquee = {
          x1: world.x,
          y1: world.y,
          x2: world.x,
          y2: world.y,
          additive: !!e.shiftKey,
        };
        if (!e.shiftKey) {
          state.selectedIds.clear();
          state.selectedConnectorIds.clear();
        }
        draw();
        return;
      }

      // rotate / resize?
      if (state.selectedIds.size === 1) {
        const sel = state.objects.find((o) => o.id === [...state.selectedIds][0]);
        if (sel) {
          if (hitRotationHandle(sel, world.x, world.y)) {
            const c = centerOf(sel);
            state.rotating = {
              id: sel.id,
              center: c,
              startAngle: Math.atan2(world.y - c.y, world.x - c.x),
              origRotation: sel.rotation || 0,
            };
            return;
          }
          const corner = hitResizeHandle(sel, world.x, world.y);
          if (corner) {
            state.resizing = {
              id: sel.id,
              corner,
              start: world,
              orig: structuredClone(sel),
              childOriginals: sel.type === 'cardLink'
                ? Object.fromEntries(childrenOfCardLink(sel.id).map((o) => [o.id, structuredClone(o)]))
                : null,
            };
            return;
          }
        }
      }

      const hit = hitTest(world.x, world.y);
      const hitConn = hit ? null : hitTestConnector(world.x, world.y);

      const now = Date.now();
      if (!hit && !hitConn && state.selectedIds.size === 0 && lastClick.id === null && now - lastClick.time < 350) {
        // double-click empty canvas → text
        const obj = {
          id: uid('obj'),
          type: 'text',
          x: world.x,
          y: world.y,
          text: '',
          stroke: state.textColor,
          textColor: state.textColor,
          fontSize: state.fontSize || 18,
          w: 200,
          h: 28,
          rotation: 0,
        };
        state.objects.push(obj);
        emit('object-add', obj);
        state.selectedIds = new Set([obj.id]);
        syncColorTargetFromSelection();
        draw();
        queueInlineEdit(obj);
        lastClick = { time: 0, id: null };
        return;
      }
      if (hit && lastClick.id === hit.id && now - lastClick.time < 350) {
        if (hit.type === 'roomLink') {
          if (e.altKey) openRoomLinkPanel(hit);
          else navigateRoomLink(hit);
        } else if (hit.type === 'cardLink') {
          if (e.altKey) openCardLinkPanel(hit);
          else navigateCardLink(hit);
        } else if (DB_TYPES.has(hit.type)) {
          // Tables/views/enums: full columns editor (name + columns + types)
          if (DB_COLUMN_TYPES.includes(hit.type) || e.shiftKey) queueInlineEditAttrs(hit);
          else queueInlineEdit(hit);
        } else {
          queueInlineEdit(hit);
        }
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
        syncColorTargetFromSelection();
        {
          const primaryIds = [...state.selectedIds];
          const dragIds = expandDragIdsWithChildren(primaryIds);
          state.dragging = {
            ids: dragIds,
            primaryIds,
            start: world,
            originals: Object.fromEntries(
              state.objects.filter((o) => dragIds.includes(o.id)).map((o) => [o.id, structuredClone(o)])
            ),
          };
        }
      } else if (hitConn) {
        if (!e.shiftKey) {
          state.selectedIds.clear();
          state.selectedConnectorIds.clear();
        }
        state.selectedConnectorIds.add(hitConn.id);
        syncColorTargetFromSelection();
        draw();
        return;
      } else {
        // Empty canvas: drag to marquee-select (LMB), like Miro/Figma
        try { canvasWrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        state.marquee = {
          x1: world.x,
          y1: world.y,
          x2: world.x,
          y2: world.y,
          additive: !!e.shiftKey,
        };
        if (!e.shiftKey) {
          state.selectedIds.clear();
          state.selectedConnectorIds.clear();
        }
        draw();
        return;
      }
    }

    const shapeTools = ['rect', 'square', 'circle', 'ellipse', 'task', 'gateway', 'event', 'cardLink',
      'dbTable', 'dbView', 'dbSchema', 'dbDatabase', 'dbIndex', 'dbProcedure', 'dbTrigger', 'dbEnum'];
    if (shapeTools.includes(state.tool)) {
      const isDb = DB_TYPES.has(state.tool);
      const meta = isDb ? DB_META[state.tool] : null;
      state.drawing = {
        id: uid('obj'),
        type: state.tool,
        x: world.x,
        y: world.y,
        w: 0,
        h: 0,
        stroke: state.strokeColor,
        fill: state.tool === 'cardLink' ? 'rgba(34,197,94,0.08)' : (isDb ? 'rgba(14,165,233,0.08)' : 'transparent'),
        strokeWidth: 2,
        label: isDb ? (meta && meta.defaultLabel) || '' : '',
        text: isDb ? (meta && meta.defaultAttrs) || '' : '',
        textColor: state.textColor,
        fontSize: state.fontSize || 18,
        rotation: 0,
        ...(state.tool === 'cardLink' ? {
          cardId: null,
          cardBoard: state.kanbanMode === 'room' ? 'room' : 'personal',
        } : {}),
      };
      return;
    }

    if (state.tool === 'pen') {
      state.drawing = {
        id: uid('obj'),
        type: 'pen',
        stroke: state.strokeColor,
        strokeWidth: state.penStrokeWidth || 2.5,
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
        label: '',
        textColor: state.textColor,
        fontSize: state.fontSize || 14,
      };
      return;
    }

    if (state.tool === 'roomLink') {
      const obj = {
        id: uid('obj'),
        type: 'roomLink',
        x: world.x - 90,
        y: world.y - 36,
        w: 180,
        h: 72,
        stroke: state.strokeColor,
        fill: 'rgba(59,130,246,0.14)',
        strokeWidth: 2,
        roomId: '',
        label: '',
        text: '',
        textColor: state.textColor,
        fontSize: state.fontSize || 18,
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      syncColorTargetFromSelection();
      setTool('select');
      draw();
      openRoomLinkPanel(obj);
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
        textColor: state.textColor,
        fontSize: state.fontSize || 18,
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      syncColorTargetFromSelection();
      setTool('select');
      draw();
      queueInlineEdit(obj);
      return;
    }

    if (state.tool === 'text') {
      const obj = {
        id: uid('obj'),
        type: 'text',
        x: world.x,
        y: world.y,
        text: '',
        stroke: state.textColor,
        textColor: state.textColor,
        fontSize: state.fontSize || 18,
        w: 200,
        h: 28,
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      syncColorTargetFromSelection();
      setTool('select');
      draw();
      queueInlineEdit(obj);
    }
  });

  canvasWrap.addEventListener('pointermove', (e) => {
    const pt = getLocalPoint(e);
    const world = worldFromScreen(pt.x, pt.y);
    state.lastPointerWorld = { x: world.x, y: world.y };
    sendCursor(world.x, world.y);

    if (state.panning) {
      const dx = (pt.x - state.panning.sx) / state.camera.scale;
      const dy = (pt.y - state.panning.sy) / state.camera.scale;
      state.camera.x = state.panning.cx + dx;
      state.camera.y = state.panning.cy + dy;
      draw();
      return;
    }

    if (state.marquee) {
      state.marquee.x2 = world.x;
      state.marquee.y2 = world.y;
      draw();
      return;
    }

    if (state.rotating) {
      const obj = state.objects.find((o) => o.id === state.rotating.id);
      if (obj) {
        const c = state.rotating.center;
        const ang = Math.atan2(world.y - c.y, world.x - c.x);
        let deg = state.rotating.origRotation + ((ang - state.rotating.startAngle) * 180) / Math.PI;
        deg = ((Math.round(deg) % 360) + 360) % 360;
        if (deg > 180) deg -= 360;
        obj.rotation = deg;
        emit('object-update', obj);
        syncRotationUI(deg);
        draw();
      }
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
        if (obj.type === 'cardLink' && state.resizing.childOriginals) {
          const dx = obj.x - orig.x;
          const dy = obj.y - orig.y;
          for (const [cid, corig] of Object.entries(state.resizing.childOriginals)) {
            const child = state.objects.find((o) => o.id === cid);
            if (!child) continue;
            applyDelta(child, corig, dx, dy);
            emit('object-update', child);
          }
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
      if (state.tool === 'select' && !state.dragging && !state.resizing && !state.rotating && !state.panning && !state.marquee) {
        canvasWrap.style.cursor = findDbSettingsHit(world.x, world.y) ? 'pointer' : 'default';
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

  function finishMarqueeIfAny() {
    if (!state.marquee) return;
    applyMarqueeSelection(state.marquee);
    state.marquee = null;
    syncColorTargetFromSelection();
    draw();
  }

  canvasWrap.addEventListener('pointerup', () => {
    flushPendingInlineEdit();
    finishMarqueeIfAny();
    if (state.panning) {
      state.panning = false;
      setTool(state.tool);
    }
    if (state.dragging) {
      const primary = state.dragging.primaryIds || state.dragging.ids;
      reparentAfterDrag(primary);
      state.dragging = null;
      draw();
    }
    if (state.resizing) {
      const obj = state.objects.find((o) => o.id === state.resizing.id);
      if (obj) {
        normalizeShape(obj);
        emit('object-update', obj);
      }
      state.resizing = null;
      draw();
    }
    if (state.rotating) {
      const obj = state.objects.find((o) => o.id === state.rotating.id);
      if (obj) emit('object-update', obj);
      state.rotating = null;
      draw();
    }
    if (state.drawing) {
      let obj = state.drawing;
      state.drawing = null;
      if (obj.type === 'pen') {
        if (!obj.points || obj.points.length < 2) {
          return draw();
        }
        // Stay on pencil; defer commit until tool change
        state.pendingPens.push(obj);
        draw();
        return;
      }
      if (SHAPE_TYPES.has(obj.type) && Math.abs(obj.w) < 4 && Math.abs(obj.h) < 4) {
        // default size click
        obj.w = obj.type === 'event' ? 100 : 80;
        obj.h = obj.type === 'event' ? 50 : 80;
        if (obj.type === 'task') { obj.w = 120; obj.h = 70; }
        if (obj.type === 'cardLink') { obj.w = 160; obj.h = 100; }
        if (DB_TYPES.has(obj.type)) { obj.w = 200; obj.h = 140; }
      }
      if (obj.type === 'cardLink') {
        if (Math.abs(obj.w) < 160) obj.w = (obj.w < 0 ? -1 : 1) * 160;
        if (Math.abs(obj.h) < 100) obj.h = (obj.h < 0 ? -1 : 1) * 100;
      }
      if ((obj.type === 'line' || obj.type === 'arrow') && Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) < 3) {
        setTool('select');
        return draw();
      }
      obj = normalizeShape(obj);
      if (obj.rotation == null && ROTATABLE_TYPES.has(obj.type)) obj.rotation = 0;
      pushHistory();
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      syncColorTargetFromSelection();
      setTool('select');
      draw();
      if (obj.type === 'cardLink') openCardLinkPanel(obj);
      if (DB_COLUMN_TYPES.includes(obj.type)) openDbColumnsPanel(obj);
      else if (DB_TYPES.has(obj.type)) queueInlineEdit(obj);
    }
  });

  canvasWrap.addEventListener('pointercancel', () => {
    finishMarqueeIfAny();
    if (state.panning) {
      state.panning = false;
      setTool(state.tool);
    }
    state.dragging = null;
    state.resizing = null;
    state.rotating = null;
    state.drawing = null;
  });

  canvasWrap.addEventListener('pointerleave', () => {
    emit('cursor-move', null);
    state.hoverId = null;
    state.hoverConnectorId = null;
    state._connectorPreview = null;
    draw();
  });

  // ---------- Canvas images (drop / paste) ----------
  function resizeCanvasImageDataUrl(file, maxEdge = 1920) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('img'));
        img.onload = () => {
          let w = img.naturalWidth || img.width || 1;
          let h = img.naturalHeight || img.height || 1;
          const naturalW = w;
          const naturalH = h;
          if (w > maxEdge || h > maxEdge) {
            const scale = Math.min(maxEdge / w, maxEdge / h);
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
          }
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const cctx = c.getContext('2d');
          cctx.drawImage(img, 0, 0, w, h);
          let type = (file && file.type) || 'image/png';
          if (type === 'image/jpg') type = 'image/jpeg';
          if (type === 'image/gif') type = 'image/png'; // canvas flattens animated GIF
          if (!/^image\/(png|jpeg|webp)$/i.test(type)) type = 'image/png';
          const quality = (type === 'image/jpeg' || type === 'image/webp') ? 0.9 : undefined;
          resolve({
            dataUrl: c.toDataURL(type, quality),
            naturalW,
            naturalH,
            w,
            h,
          });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function defaultImageBoardSize(naturalW, naturalH) {
    const nw = Math.max(1, naturalW || 1);
    const nh = Math.max(1, naturalH || 1);
    const maxDim = 400;
    const scale = Math.min(maxDim / nw, maxDim / nh, 1);
    return {
      w: Math.max(1, Math.round(nw * scale)),
      h: Math.max(1, Math.round(nh * scale)),
    };
  }

  function viewportCenterWorld() {
    const rect = canvasWrap.getBoundingClientRect();
    return worldFromScreen(rect.width / 2, rect.height / 2);
  }

  async function placeImageFromFile(file, worldX, worldY) {
    if (!file || !state.token || !state.roomId) return false;
    if (!looksLikeImageFile(file)) {
      toast('Выберите файл изображения');
      return false;
    }
    try {
      const prepared = await resizeCanvasImageDataUrl(file, 1920);
      if (prepared.dataUrl.length > 4.2e6) {
        toast('Изображение слишком большое');
        return false;
      }
      const { data } = await api('/api/canvas-image', {
        method: 'POST',
        body: JSON.stringify({ image: prepared.dataUrl }),
      });
      if (!data || !data.ok || !data.url) {
        toast((data && data.error) || 'Не удалось загрузить картинку');
        return false;
      }
      const size = defaultImageBoardSize(prepared.w, prepared.h);
      const obj = {
        id: uid('obj'),
        type: 'image',
        x: worldX - size.w / 2,
        y: worldY - size.h / 2,
        w: size.w,
        h: size.h,
        src: data.url,
        naturalW: prepared.naturalW,
        naturalH: prepared.naturalH,
      };
      state.objects.push(obj);
      emit('object-add', obj);
      state.selectedIds = new Set([obj.id]);
      state.selectedConnectorIds.clear();
      syncColorTargetFromSelection();
      setTool('select');
      getCachedImage(obj.src);
      draw();
      toast('Картинка добавлена');
      return true;
    } catch (err) {
      console.error('placeImageFromFile', err);
      toast('Не удалось загрузить картинку');
      return false;
    }
  }

  function looksLikeImageFile(f) {
    if (!f) return false;
    if (f.type && f.type.startsWith('image/')) return true;
    const name = String(f.name || '').toLowerCase();
    return /\.(png|jpe?g|gif|webp|bmp)$/.test(name);
  }

  function extractImageFilesFromDataTransfer(dt) {
    if (!dt) return [];
    const out = [];
    const seen = new Set();
    const push = (f) => {
      if (!f || !looksLikeImageFile(f)) return;
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(f);
    };
    if (dt.items && dt.items.length) {
      for (const item of dt.items) {
        if (item.kind === 'file') {
          const t = item.type || '';
          if (!t || t.startsWith('image/') || t === 'application/octet-stream') {
            const f = item.getAsFile();
            push(f);
          }
        }
      }
    }
    if (dt.files && dt.files.length) {
      for (const f of dt.files) push(f);
    }
    return out;
  }

  ['dragenter', 'dragover'].forEach((evt) => {
    canvasWrap.addEventListener(evt, (e) => {
      if (state.view !== 'canvas') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
  });

  canvasWrap.addEventListener('drop', async (e) => {
    if (state.view !== 'canvas') return;
    e.preventDefault();
    e.stopPropagation();
    const files = extractImageFilesFromDataTransfer(e.dataTransfer);
    if (!files.length) return;
    const pt = getLocalPoint(e);
    const world = worldFromScreen(pt.x, pt.y);
    // Place sequentially so selection ends on the last one
    for (const file of files) {
      await placeImageFromFile(file, world.x, world.y);
    }
  });

  // Prevent browser from navigating away if drop misses canvas but lands on app shell
  document.addEventListener('dragover', (e) => {
    if (state.view === 'canvas') e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (state.view === 'canvas') e.preventDefault();
  });

  window.addEventListener('paste', async (e) => {
    if (!state.roomId) return;
    if (state.view !== 'canvas') return;
    const ae = document.activeElement;
    // Allow paste on canvas even if a non-text control had focus; block only real typing surfaces
    if (isTypingTarget(e.target) || isTypingTarget(ae)) {
      const tag = (ae && ae.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae && ae.isContentEditable)) return;
      if (state.inlineEdit) return;
    }
    const dt = e.clipboardData;
    // Synchronously snapshot files before await (clipboardData expires)
    const files = extractImageFilesFromDataTransfer(dt);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = state.lastPointerWorld || viewportCenterWorld();
    for (const file of files) {
      await placeImageFromFile(file, pos.x, pos.y);
    }
  }, true);

  // ---------- Kanban ----------
  function applyPersonalKanbanState(payload) {
    if (!payload) return;
    state.personalColumns = Array.isArray(payload.columns) ? payload.columns : [];
    state.personalCards = (Array.isArray(payload.cards) ? payload.cards : []).map((c) => ({
      dueDate: null,
      ...c,
    }));
    if (state.kanbanMode === 'personal' && state.view === 'kanban') renderKanban();
  }

  function activeColumns() {
    return state.kanbanMode === 'personal' ? state.personalColumns : state.columns;
  }

  function activeCards() {
    return state.kanbanMode === 'personal' ? state.personalCards : state.cards;
  }

  function kanbanEmit(name, data, ack) {
    const event = state.kanbanMode === 'personal' ? ('personal-' + name) : name;
    emit(event, data, ack);
  }

  function cardsInColumn(colId) {
    return activeCards()
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
    updateKanbanChrome();
    kanbanBoard.innerHTML = '';
    const cols = [...activeColumns()].sort((a, b) => a.order - b.order);
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
        const roomCode = normalizeRoomCode(card.linkedRoomId);
        const roomHtml = roomCode
          ? `<button type="button" class="kanban-card-room" data-room="${escapeHtml(roomCode)}" title="Открыть комнату">🔗 ${escapeHtml(roomCode)}</button>`
          : '';
        cardEl.innerHTML = `
          <h4>${escapeHtml(card.title)}</h4>
          ${card.description ? `<p>${escapeHtml(card.description)}</p>` : ''}
          ${roomHtml}${dueHtml}
        `;
        cardEl.addEventListener('dragstart', (ev) => {
          cardEl.classList.add('dragging');
          ev.dataTransfer.setData('text/plain', card.id);
          ev.dataTransfer.effectAllowed = 'move';
        });
        cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
        cardEl.addEventListener('click', () => openCardPanel(card.id));
        const roomChip = $('.kanban-card-room', cardEl);
        if (roomChip) {
          roomChip.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const code = normalizeRoomCode(roomChip.dataset.room);
            if (!code) return;
            if (code === state.roomId) {
              toast('Уже в этой комнате');
              return;
            }
            toast(`Переход в ${code}`);
            enterRoom(code);
          });
        }
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
        kanbanEmit('card-add', {
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
        if (state.kanbanMode === 'personal') {
          kanbanEmit('column-update', { id: input.dataset.col, title: input.value.trim() || 'Колонка' });
        } else {
          emit('column-rename', { id: input.dataset.col, title: input.value.trim() || 'Колонка' });
        }
      });
    });

    $$('.kanban-col-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (activeColumns().length <= 1) {
          toast('Нужна хотя бы одна колонка');
          return;
        }
        kanbanEmit('column-delete', { id: btn.dataset.delCol });
      });
    });
  }

  $('#btn-add-column').addEventListener('click', () => {
    kanbanEmit('column-add', { title: 'Новая колонка' });
  });

  function moveCardToColumn(cardId, columnId) {
    const card = activeCards().find((c) => c.id === cardId);
    if (!card) return;
    const order = cardsInColumn(columnId).filter((c) => c.id !== cardId).length;
    card.columnId = columnId;
    card.order = order;
    kanbanEmit('card-update', { id: cardId, columnId, order });
    renderKanban();
  }

  function syncCardPanel(card) {
    if (!card || state.editingCardId !== card.id) return;
    if (document.activeElement !== $('#card-title')) $('#card-title').value = card.title;
    if (document.activeElement !== $('#card-desc')) $('#card-desc').value = card.description || '';
    if (document.activeElement !== $('#card-due')) $('#card-due').value = card.dueDate || '';
    if (document.activeElement !== $('#card-room-link')) {
      $('#card-room-link').value = card.linkedRoomId || '';
    }
  }

  function openCardPanel(id) {
    const card = activeCards().find((c) => c.id === id);
    if (!card) return;
    state.editingCardId = id;
    $('#card-title').value = card.title;
    $('#card-desc').value = card.description || '';
    $('#card-due').value = card.dueDate || '';
    $('#card-room-link').value = card.linkedRoomId || '';
    cardPanel.classList.remove('hidden');
  }

  function closeCardPanel() {
    cardPanel.classList.add('hidden');
    state.editingCardId = null;
  }

  function saveCardPanel() {
    if (!state.editingCardId) return;
    kanbanEmit('card-update', {
      id: state.editingCardId,
      title: $('#card-title').value.trim() || 'Без названия',
      description: $('#card-desc').value,
      dueDate: $('#card-due').value || null,
      linkedRoomId: normalizeRoomCode($('#card-room-link').value) || null,
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
    kanbanEmit('card-delete', { id: state.editingCardId });
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
  $('#card-room-link').addEventListener('input', scheduleCardSync);
  $('#card-room-link').addEventListener('change', () => {
    saveCardPanel();
  });
  $('#card-open-room').addEventListener('click', () => {
    const code = normalizeRoomCode($('#card-room-link').value);
    if (!code) {
      toast('Укажите код комнаты');
      return;
    }
    if (code === state.roomId) {
      toast('Уже в этой комнате');
      return;
    }
    saveCardPanel();
    toast(`Переход в ${code}`);
    enterRoom(code);
  });

  // ---------- Chat ----------
  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function isMyChatMessage(msg) {
    if (!msg) return false;
    if (state.account && msg.accountId && msg.accountId === state.account.id) return true;
    if (msg.userId && msg.userId === state.userId) return true;
    return false;
  }

  function chatMessageIsRead(msg) {
    if (!isMyChatMessage(msg)) return true;
    const others = [...state.users.values()].filter((u) => u.id !== state.userId);
    if (!others.length) return false;
    // Another user moved mouse after this message
    return !!(state.lastOtherCursorAt && state.lastOtherCursorAt >= (msg.ts || 0));
  }

  function appendChatMessage(msg, scroll) {
    const el = document.createElement('div');
    el.className = 'chat-msg' + (isMyChatMessage(msg) ? ' mine' : '');
    el.dataset.msgId = msg.id || '';
    el.dataset.ts = String(msg.ts || 0);
    const receipt = isMyChatMessage(msg)
      ? (chatMessageIsRead(msg)
        ? '<span class="chat-receipt read" title="Прочитано">✓✓</span>'
        : '<span class="chat-receipt unread" title="Не прочитано">✓</span>')
      : '';
    el.innerHTML = `
      <div class="chat-msg-meta">
        <span class="chat-msg-name" style="color:${msg.color || '#93c5fd'}">${escapeHtml(msg.name)}</span>
        <span class="chat-msg-time">${formatTime(msg.ts)}</span>
        ${receipt}
      </div>
      <div class="chat-msg-text">${escapeHtml(msg.text)}</div>
    `;
    chatMessages.appendChild(el);
    if (scroll) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function refreshChatReadReceipts() {
    if (!chatMessages) return;
    $$('.chat-msg.mine', chatMessages).forEach((el) => {
      const ts = Number(el.dataset.ts || 0);
      const read = !!(state.lastOtherCursorAt && state.lastOtherCursorAt >= ts)
        && [...state.users.values()].some((u) => u.id !== state.userId);
      const badge = el.querySelector('.chat-receipt');
      if (!badge) return;
      badge.classList.toggle('read', read);
      badge.classList.toggle('unread', !read);
      badge.title = read ? 'Прочитано' : 'Не прочитано';
      badge.textContent = read ? '✓✓' : '✓';
    });
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

  function setSideMode(mode) {
    state.sideMode = mode;
    $('#side-tab-chat').classList.toggle('active', mode === 'chat');
    $('#side-tab-dm').classList.toggle('active', mode === 'dm');
    $('#side-chat').classList.toggle('hidden', mode !== 'chat');
    $('#side-dm').classList.toggle('hidden', mode !== 'dm');
    if (mode === 'dm') {
      refreshDmUsers();
      if (state.dmOtherId) openDmThread(state.dmOtherId);
    }
  }
  $('#side-tab-chat').addEventListener('click', () => setSideMode('chat'));
  $('#side-tab-dm').addEventListener('click', () => setSideMode('dm'));

  $('#btn-toggle-chat').addEventListener('click', () => {
    chatPanel.classList.toggle('collapsed');
    $('#btn-toggle-chat').textContent = chatPanel.classList.contains('collapsed') ? '▶' : '◀';
    resizeCanvas();
  });

  // ---------- DMs ----------
  function updateDmBadge() {
    const n = state.dmTotalUnread || 0;
    if (n > 0) {
      dmBadge.textContent = n > 99 ? '99+' : String(n);
      dmBadge.classList.remove('hidden');
    } else {
      dmBadge.classList.add('hidden');
    }
  }

  function refreshDmUsers() {
    if (!state.socket || !state.socket.connected) return;
    state.socket.emit('dm-list-users', (res) => {
      if (!res || !res.ok) return;
      state.dmUsers = res.users || [];
      state.dmTotalUnread = res.totalUnread || 0;
      updateDmBadge();
      renderDmUsers();
    });
  }

  function isFavoritesUser(u) {
    return !!(u && (u.isFavorites || (state.account && u.id === state.account.id)));
  }

  function renderDmUsers() {
    dmUsersEl.innerHTML = '';
    const users = state.dmUsers.slice();
    // Ensure Избранные always present at top
    if (state.account && !users.some((u) => u.id === state.account.id)) {
      users.unshift({
        id: state.account.id,
        displayName: 'Избранные',
        username: 'favorites',
        isFavorites: true,
        online: true,
        unread: 0,
        avatarUrl: state.account.avatarUrl || null,
      });
    }
    users.sort((a, b) => {
      const af = isFavoritesUser(a) ? 0 : 1;
      const bf = isFavoritesUser(b) ? 0 : 1;
      if (af !== bf) return af - bf;
      return String(a.username || '').localeCompare(String(b.username || ''));
    });
    if (!users.length) {
      const empty = document.createElement('div');
      empty.className = 'dm-thread-head';
      empty.textContent = 'Пока нет других пользователей';
      dmUsersEl.appendChild(empty);
      return;
    }
    for (const u of users) {
      const fav = isFavoritesUser(u);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dm-user' + (u.id === state.dmOtherId ? ' active' : '') + (fav ? ' favorites' : '');
      const label = fav ? '⭐ Избранные' : escapeHtml(u.displayName || u.username);
      const unread = !fav && u.unread > 0
        ? `<span class="dm-user-unread">${u.unread > 99 ? '99+' : u.unread}</span>`
        : '';
      const initial = fav ? '⭐' : escapeHtml(((u.displayName || u.username || '?').trim().charAt(0) || '?').toUpperCase());
      const avatarHtml = (!fav && u.avatarUrl)
        ? `<span class="user-avatar dm-user-avatar img-avatar"><img src="${escapeHtml(u.avatarUrl)}" alt="" /></span>`
        : `<span class="user-avatar dm-user-avatar">${initial}</span>`;
      btn.innerHTML = `
        <span class="dm-user-dot${u.online ? ' online' : ''}" title="${u.online ? 'в сети' : 'не в сети'}"></span>
        ${avatarHtml}
        <span class="dm-user-name">${label}</span>
        ${unread}
      `;
      btn.addEventListener('click', () => openDmThread(u.id));
      dmUsersEl.appendChild(btn);
    }
  }

  function openDmThread(otherId) {
    state.dmOtherId = otherId;
    const u = state.dmUsers.find((x) => x.id === otherId);
    const fav = isFavoritesUser(u) || (state.account && otherId === state.account.id);
    dmThreadHead.textContent = fav
      ? 'Избранные'
      : (u ? `ЛС: ${u.displayName || u.username}` : 'Личные сообщения');
    dmInput.disabled = false;
    $('#dm-send-btn').disabled = false;
    renderDmUsers();
    state.socket.emit('dm-get-thread', { otherId }, (res) => {
      if (!res || !res.ok) return;
      state.dmMessages = res.messages || [];
      renderDmMessages();
    });
    state.socket.emit('dm-mark-read', { otherId }, (res) => {
      if (res && res.ok) {
        const uu = state.dmUsers.find((x) => x.id === otherId);
        if (uu) uu.unread = 0;
        if (typeof res.totalUnread === 'number') state.dmTotalUnread = res.totalUnread;
        updateDmBadge();
        renderDmUsers();
      }
    });
  }

  function renderDmMessages() {
    dmMessagesEl.innerHTML = '';
    for (const msg of state.dmMessages) appendDmMessage(msg, false);
    dmMessagesEl.scrollTop = dmMessagesEl.scrollHeight;
  }

  function appendDmMessage(msg, scroll) {
    const mine = state.account && msg.fromId === state.account.id;
    const name = mine
      ? 'Вы'
      : (msg.fromName || (state.dmUsers.find((u) => u.id === msg.fromId) || {}).displayName || '…');
    const el = document.createElement('div');
    el.className = 'chat-msg' + (mine ? ' mine' : '');
    el.innerHTML = `
      <div class="chat-msg-meta">
        <span class="chat-msg-name" style="color:${mine ? state.userColor : '#93c5fd'}">${escapeHtml(name)}</span>
        <span class="chat-msg-time">${formatTime(msg.ts)}</span>
      </div>
      <div class="chat-msg-text">${escapeHtml(msg.text)}</div>
    `;
    dmMessagesEl.appendChild(el);
    if (scroll) dmMessagesEl.scrollTop = dmMessagesEl.scrollHeight;
  }

  function handleIncomingDm(msg) {
    if (!msg || !msg.id) return;
    const otherId = state.account && msg.fromId === state.account.id ? msg.toId : msg.fromId;
    const viewing = state.sideMode === 'dm' && state.dmOtherId === otherId && !document.hidden;
    if (state.dmOtherId === otherId) {
      if (!state.dmMessages.find((m) => m.id === msg.id)) {
        state.dmMessages.push(msg);
        appendDmMessage(msg, true);
      }
      if (viewing && state.socket) {
        state.socket.emit('dm-mark-read', { otherId });
      }
    }
    // refresh list counts from server events; still bump locally if from other
    if (!viewing && state.account && msg.fromId !== state.account.id) {
      const u = state.dmUsers.find((x) => x.id === msg.fromId);
      if (u) u.unread = (u.unread || 0) + 1;
      state.dmTotalUnread = (state.dmTotalUnread || 0) + 1;
      updateDmBadge();
      renderDmUsers();
      maybeNotifyDm(msg);
    } else if (state.account && msg.fromId !== state.account.id) {
      // focused thread — no notify
    } else if (document.hidden && state.account && msg.fromId !== state.account.id) {
      maybeNotifyDm(msg);
    }
    refreshDmUsers();
  }

  dmForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = dmInput.value.trim();
    if (!text || !state.dmOtherId) return;
    dmInput.value = '';
    emit('dm-send', { toId: state.dmOtherId, text }, (res) => {
      if (res && !res.ok) toast(res.error || 'Не удалось отправить');
    });
  });

  // ---------- Browser notifications ----------
  function notifSupported() {
    return typeof Notification !== 'undefined';
  }

  function updateNotifButton() {
    const btn = $('#btn-enable-notif');
    if (!btn) return;
    if (!notifSupported()) {
      btn.textContent = '🔔 Недоступно';
      btn.disabled = true;
      return;
    }
    const p = Notification.permission;
    if (p === 'granted') btn.textContent = '🔔 Вкл.';
    else if (p === 'denied') btn.textContent = '🔔 Запрещены';
    else btn.textContent = '🔔 Уведомления';
  }

  async function requestNotifPermission() {
    if (!notifSupported()) {
      toast('Уведомления не поддерживаются');
      return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') {
      toast('Разрешите уведомления в настройках браузера');
      updateNotifButton();
      return false;
    }
    try {
      const res = await Notification.requestPermission();
      updateNotifButton();
      if (res === 'granted') {
        toast('Уведомления включены');
        return true;
      }
      toast('Уведомления не разрешены');
      return false;
    } catch {
      return false;
    }
  }

  $('#btn-enable-notif').addEventListener('click', () => {
    requestNotifPermission();
  });

  function showBrowserNotification(title, body, data) {
    if (!notifSupported() || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, {
        body: String(body || '').slice(0, 120),
        tag: (data && data.tag) || undefined,
      });
      n.onclick = () => {
        try { window.focus(); } catch { /* ignore */ }
        if (data && data.type === 'dm' && data.otherId) {
          setSideMode('dm');
          openDmThread(data.otherId);
          chatPanel.classList.remove('collapsed');
        } else if (data && data.type === 'chat') {
          setSideMode('chat');
          chatPanel.classList.remove('collapsed');
        }
        n.close();
      };
    } catch { /* ignore */ }
  }

  function maybeNotifyRoomChat(msg) {
    if (!msg) return;
    if (state.account && msg.accountId === state.account.id) return;
    if (state.userId && msg.userId === state.userId) return;
    const chatFocused = state.sideMode === 'chat' && !chatPanel.classList.contains('collapsed') && !document.hidden;
    if (chatFocused) return;
    if (Notification.permission === 'default' && !state.notifPermissionAsked) {
      state.notifPermissionAsked = true;
      // soft: do not auto-prompt; wait for button
    }
    if (Notification.permission !== 'granted') return;
    const room = msg.roomId || state.roomId || 'комната';
    showBrowserNotification(
      `Чат · ${room}`,
      `${msg.name || 'Участник'}: ${msg.text}`,
      { type: 'chat', roomId: room, tag: `chat-${msg.id}` }
    );
  }

  function maybeNotifyDm(msg) {
    if (!msg || !state.account) return;
    if (msg.fromId === state.account.id) return;
    const threadOpen = state.sideMode === 'dm' && state.dmOtherId === msg.fromId && !document.hidden
      && !chatPanel.classList.contains('collapsed');
    if (threadOpen) return;
    if (Notification.permission !== 'granted') return;
    showBrowserNotification(
      `ЛС · ${msg.fromName || 'Сообщение'}`,
      msg.text,
      { type: 'dm', otherId: msg.fromId, tag: `dm-${msg.id}` }
    );
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.sideMode === 'dm' && state.dmOtherId) {
      emit('dm-mark-read', { otherId: state.dmOtherId });
    }
  });


  // ---------- Room export / import ----------
  function exportRoomData() {
    if (!state.roomId) return toast('Нет активной комнаты');
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      roomId: state.roomId,
      title: state.roomId,
      visibility: state.roomVisibility || 'public',
      camera: { ...state.camera },
      objects: state.objects,
      connectors: state.connectors,
      columns: state.columns,
      cards: state.cards,
      messages: state.messages,
      note: 'Изображения сохранены как URL (/uploads/…). При импорте на другой сервер их может понадобиться загрузить заново.',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    a.href = URL.createObjectURL(blob);
    a.download = `tarkventum-${state.roomId}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('Экспорт сохранён');
  }

  function importRoomData(file) {
    if (!file || !state.roomId) return toast('Откройте комнату для импорта');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || ''));
        if (!data || !Array.isArray(data.objects)) throw new Error('bad');
        if (!confirm('Импортировать объекты в текущую комнату? Существующие объекты останутся.')) return;
        for (const obj of data.objects) {
          if (!obj || !obj.id) continue;
          if (state.objects.find((o) => o.id === obj.id)) obj.id = uid('obj');
          state.objects.push(obj);
          emit('object-add', obj);
        }
        for (const conn of (data.connectors || [])) {
          if (!conn || !conn.id) continue;
          if (state.connectors.find((c) => c.id === conn.id)) conn.id = uid('conn');
          state.connectors.push(conn);
          emit('connector-add', conn);
        }
        draw();
        toast('Импорт выполнен');
      } catch {
        toast('Не удалось прочитать файл экспорта');
      }
    };
    reader.readAsText(file);
  }

  // ---------- Public rooms list ----------

  function worldToScreen(x, y) {
    return {
      x: (x + state.camera.x) * state.camera.scale,
      y: (y + state.camera.y) * state.camera.scale,
    };
  }

  function computeSchemeBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    const consider = (b) => {
      if (!b) return;
      any = true;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    };
    for (const o of state.objects) consider(boundsOf(o));
    if (!any) return { x: -100, y: -100, w: 800, h: 600 };
    const pad = 48;
    return { x: minX - pad, y: minY - pad, w: Math.max(120, maxX - minX + pad * 2), h: Math.max(120, maxY - minY + pad * 2) };
  }

  function exportSchemePng() {
    if (!state.objects.length) { toast('Схема пуста'); return null; }
    const b = computeSchemeBounds();
    const scale = 2;
    const prev = { x: state.camera.x, y: state.camera.y, scale: state.camera.scale };
    const rect = canvasWrap.getBoundingClientRect();
    const fit = Math.min(rect.width / b.w, rect.height / b.h) * 0.9;
    state.camera.scale = Math.max(0.05, fit);
    state.camera.x = -b.x + (rect.width / state.camera.scale - b.w) / 2;
    state.camera.y = -b.y + (rect.height / state.camera.scale - b.h) / 2;
    draw();
    const dpr = window.devicePixelRatio || 1;
    const tl = worldToScreen(b.x, b.y);
    const br = worldToScreen(b.x + b.w, b.y + b.h);
    const sx = Math.max(0, tl.x * dpr);
    const sy = Math.max(0, tl.y * dpr);
    const sw = Math.max(1, (br.x - tl.x) * dpr);
    const sh = Math.max(1, (br.y - tl.y) * dpr);
    const off = document.createElement('canvas');
    off.width = Math.ceil(b.w * scale);
    off.height = Math.ceil(b.h * scale);
    const c = off.getContext('2d');
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#0b1220';
    c.fillStyle = bg;
    c.fillRect(0, 0, off.width, off.height);
    try {
      c.drawImage(canvas, sx, sy, sw, sh, 0, 0, off.width, off.height);
    } catch (err) {
      console.warn(err);
      toast('Не удалось экспортировать схему');
      state.camera.x = prev.x; state.camera.y = prev.y; state.camera.scale = prev.scale;
      draw();
      return null;
    }
    state.camera.x = prev.x; state.camera.y = prev.y; state.camera.scale = prev.scale;
    draw();
    const a = document.createElement('a');
    a.download = `tarkventum-scheme-${state.roomId || 'board'}.png`;
    a.href = off.toDataURL('image/png');
    a.click();
    toast('Схема сохранена (PNG)');
    return off;
  }

  function exportSchemePdf() {
    const off = exportSchemePng();
    if (!off) return;
    const dataUrl = off.toDataURL('image/jpeg', 0.92);
    const w = window.open('', '_blank');
    if (!w) { toast('Разрешите всплывающие окна для печати/PDF'); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Схема ${escapeHtml(state.roomId || '')}</title>
      <style>@page{margin:12mm}html,body{margin:0;background:#111}img{width:100%;height:auto;display:block}</style></head>
      <body><img src="${dataUrl}" onload="setTimeout(()=>window.print(),250)"/></body></html>`);
    w.document.close();
    toast('Печать → «Сохранить как PDF»');
  }

  function onExportSchemeMenu() {
    const asPdf = confirm('Экспорт схемы холста\\n\\nОК — скачать PNG\\nОтмена — печать / PDF');
    if (asPdf) exportSchemePng();
    else exportSchemePdf();
  }

  function renderPublicRoomsList(rooms) {
    const lobbyList = $('#public-rooms-list');
    const sideList = $('#public-rooms-side');
    const renderInto = (el) => {
      if (!el) return;
      el.innerHTML = '';
      if (!rooms.length) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'Пока нет открытых комнат';
        el.appendChild(p);
        return;
      }
      for (const r of rooms) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'public-room-item';
        btn.innerHTML = `<span class="public-room-id">${escapeHtml(r.id)}</span>
          <span class="public-room-meta">${r.userCount || 0} онлайн${r.ownerName ? ' · ' + escapeHtml(r.ownerName) : ''}</span>`;
        btn.addEventListener('click', () => enterRoom(r.id, { addTab: true, create: false }));
        el.appendChild(btn);
      }
    };
    renderInto(lobbyList);
    renderInto(sideList);
    renderInto($('#public-rooms-modal'));
  }


  function showLobbyPublicRooms(show) {
    const block = $('#lobby-public-rooms');
    if (!block) return;
    block.classList.toggle('hidden', !show);
    if (show) refreshPublicRooms();
  }
  if (typeof roomInput !== 'undefined' && roomInput) {
    roomInput.addEventListener('focus', () => showLobbyPublicRooms(true));
    roomInput.addEventListener('input', () => {
      showLobbyPublicRooms(!!roomInput.value.trim() || document.activeElement === roomInput);
      const q = roomInput.value.trim().toLowerCase();
      $$('#public-rooms-list .public-room-item').forEach((el) => {
        const id = (el.querySelector('.public-room-id')?.textContent || el.textContent || '').toLowerCase();
        el.style.display = !q || id.includes(q) ? '' : 'none';
      });
    });
    roomInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#lobby-public-rooms')) return;
        if (!roomInput.value.trim()) showLobbyPublicRooms(false);
      }, 150);
    });
  }

  function refreshPublicRooms() {
    if (state.socket && state.socket.connected) {
      state.socket.emit('list-public-rooms', (res) => {
        if (res && res.ok) renderPublicRoomsList(res.rooms || []);
      });
    } else if (state.token) {
      api('/api/rooms/public').then(({ data }) => {
        if (data && data.ok) renderPublicRoomsList(data.rooms || []);
      }).catch(() => {});
    }
  }

  // ---------- Room owner chrome / delete / members ----------
  function updateRoomOwnerChrome() {
    const delBtn = $('#btn-delete-room');
    const memBtn = $('#btn-members');
    const isOwner = state.myRoomRole === 'owner' || (state.account && state.roomOwnerId === state.account.id);
    const isPublic = state.roomVisibility !== 'private';
    const admin = isAppAdminUser();
    // Public/open rooms: only app admin. Private: owner or app admin.
    const canDelete = isPublic ? admin : (isOwner || admin);
    if (delBtn) delBtn.classList.toggle('hidden', !canDelete);
    if (memBtn) memBtn.classList.toggle('hidden', state.roomVisibility !== 'private' && !isOwner && !admin);
    renderMembersPanel();
  }

  function renderMembersPanel() {
    const list = $('#members-list');
    if (!list) return;
    list.innerHTML = '';
    const members = state.roomMembers || [];
    if (!members.length) {
      list.innerHTML = '<p class="hint">Нет участников</p>';
      return;
    }
    const isOwner = state.myRoomRole === 'owner';
    for (const m of members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      const roleLabel = m.role === 'owner' ? 'Владелец' : m.role === 'editor' ? 'Редактор' : m.role === 'admin' ? 'Админ' : 'Участник';
      row.innerHTML = `<span class="member-name">${escapeHtml(m.displayName || m.username || m.userId)}</span>
        <span class="member-role">${roleLabel}</span>`;
      if (isOwner && m.role !== 'owner') {
        const roleSel = document.createElement('select');
        roleSel.innerHTML = '<option value="member">Участник</option><option value="editor">Редактор</option><option value="admin">Админ</option>';
        roleSel.value = m.role === 'admin' || m.role === 'editor' ? m.role : 'member';
        roleSel.addEventListener('change', () => {
          emit('room-set-role', { roomId: state.roomId, userId: m.userId, role: roleSel.value }, (res) => {
            if (!res || !res.ok) toast((res && res.error) || 'Ошибка');
            else { state.roomMembers = res.members; renderMembersPanel(); }
          });
        });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn ghost small';
        rm.textContent = 'Удалить';
        rm.addEventListener('click', () => {
          if (!confirm('Удалить участника?')) return;
          emit('room-remove-member', { roomId: state.roomId, userId: m.userId }, (res) => {
            if (!res || !res.ok) toast((res && res.error) || 'Ошибка');
            else { state.roomMembers = res.members; renderMembersPanel(); }
          });
        });
        row.appendChild(roleSel);
        row.appendChild(rm);
      }
      list.appendChild(row);
    }
  }

  function deleteCurrentRoom() {
    if (!state.roomId) return;
    if (!confirm(`Удалить комнату «${state.roomId}» для всех? Это действие необратимо.`)) return;
    emit('delete-room', { roomId: state.roomId }, (res) => {
      if (!res || !res.ok) return toast((res && res.error) || 'Не удалось удалить');
      toast('Комната удалена');
      closeTab(state.roomId);
      refreshPublicRooms();
    });
  }

  // ---------- Profile modal ----------
  function openProfileModal() {
    const modal = $('#modal-profile');
    if (!modal || !state.account) return;
    $('#profile-display-name').value = state.account.displayName || '';
    $('#profile-username').value = state.account.username || '';
    $('#profile-password-current').value = '';
    $('#profile-password-new').value = '';
    $('#profile-password-confirm').value = '';
    $('#profile-error').classList.add('hidden');
    modal.classList.remove('hidden');
  }
  function closeProfileModal() {
    const modal = $('#modal-profile');
    if (modal) modal.classList.add('hidden');
  }

  async function saveProfile() {
    const errEl = $('#profile-error');
    const showErr = (t) => { if (errEl) { errEl.textContent = t; errEl.classList.remove('hidden'); } toast(t); };
    const displayName = $('#profile-display-name').value.trim();
    const username = $('#profile-username').value.trim();
    const { res, data } = await api('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName, username }),
    });
    if (!res.ok || !data || !data.ok) return showErr((data && data.error) || 'Не удалось сохранить профиль');
    state.account = data.user;
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    updateUserChrome();

    const cur = $('#profile-password-current').value;
    const neu = $('#profile-password-new').value;
    const conf = $('#profile-password-confirm').value;
    if (cur || neu || conf) {
      if (neu !== conf) return showErr('Новый пароль и подтверждение не совпадают');
      const pw = await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: cur, newPassword: neu }),
      });
      if (!pw.res.ok || !pw.data || !pw.data.ok) return showErr((pw.data && pw.data.error) || 'Не удалось сменить пароль');
      toast('Пароль обновлён');
    }
    closeProfileModal();
    toast('Профиль сохранён');
  }

  // Wire UI once DOM ready pieces exist
  const btnExport = $('#btn-export-room');
  if (btnExport) btnExport.addEventListener('click', exportRoomData);
  const importInput = $('#import-room-file');
  if (importInput) {
    importInput.addEventListener('change', () => {
      const f = importInput.files && importInput.files[0];
      if (f) importRoomData(f);
      importInput.value = '';
    });
  }
  const btnImport = $('#btn-import-room');
  if (btnImport && importInput) btnImport.addEventListener('click', () => importInput.click());
  const btnDelRoom = $('#btn-delete-room');
  if (btnDelRoom) btnDelRoom.addEventListener('click', deleteCurrentRoom);
  const btnMembers = $('#btn-members');
  if (btnMembers) btnMembers.addEventListener('click', () => {
    const p = $('#members-panel');
    if (p) p.classList.toggle('hidden');
    renderMembersPanel();
  });
  const btnInvite = $('#members-invite-btn');
  if (btnInvite) btnInvite.addEventListener('click', () => {
    const username = ($('#members-invite-user') || {}).value || '';
    const role = ($('#members-invite-role') || {}).value || 'member';
    emit('room-invite', { roomId: state.roomId, username: username.trim(), role }, (res) => {
      if (!res || !res.ok) return toast((res && res.error) || 'Не удалось пригласить');
      state.roomMembers = res.members;
      renderMembersPanel();
      toast('Участник добавлен');
      $('#members-invite-user').value = '';
    });
  });
  const btnProfile = $('#btn-profile');
  if (btnProfile) btnProfile.addEventListener('click', openProfileModal);
  const profileSave = $('#profile-save');
  if (profileSave) profileSave.addEventListener('click', () => { saveProfile(); });
  const profileCancel = $('#profile-cancel');
  if (profileCancel) profileCancel.addEventListener('click', closeProfileModal);
  const profileAvatar = $('#profile-avatar-btn');
  if (profileAvatar) profileAvatar.addEventListener('click', () => {
    const inp = $('#avatar-file-input');
    if (inp) inp.click();
  });

  // Periodic receipt refresh (idle threshold ~8s without other cursor → stay unread until move after msg)
  setInterval(() => refreshChatReadReceipts(), 2000);

  const membersClose = $('#members-panel-close');
  if (membersClose) membersClose.addEventListener('click', () => $('#members-panel').classList.add('hidden'));

  function maybeAutoJoinRoom() {
    if (!pathMatch || !state.account) return;
    const code = pathMatch[1].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || pathMatch[1];
    upsertTab(code);
    setTimeout(() => enterRoom(pathMatch[1]), 50);
  }

  updateNotifButton();
  tryRestoreSession().then((ok) => {
    if (ok) maybeAutoJoinRoom();
  });

  const btnExportScheme = $('#btn-export-scheme');
  if (btnExportScheme) btnExportScheme.addEventListener('click', onExportSchemeMenu);

})();
