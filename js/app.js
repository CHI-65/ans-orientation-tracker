/**
 * ANS Orientation Tracker — Cal Harris Jr.
 * Per-day markers on a -3..+3 grid, persisted in localStorage.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'ans-orientation-tracker:v1';
  const TZ = 'America/Los_Angeles';
  const RANGE = 3; // axes -3..+3

  /** @typedef {{ id: string, n: number, x: number, y: number, note: string, createdAt: string, updatedAt?: string }} Marker */
  /** @typedef {{ version: number, days: Record<string, Marker[]> }} Store */

  const $ = (sel, root = document) => root.querySelector(sel);

  // ——— Time helpers (America/Los_Angeles) ———
  function nowISO() {
    return new Date().toISOString();
  }

  /** Calendar day key (YYYY-MM-DD) in America/Los_Angeles */
  function dayKeyFromDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  function parseDayKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    // Noon UTC avoids DST edge weirdness when shifting days
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }

  function shiftDayKey(key, delta) {
    const dt = parseDayKey(key);
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dayKeyFromDate(dt);
  }

  function formatFriendly(iso) {
    try {
      const d = new Date(iso);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      }).format(d);
    } catch {
      return iso;
    }
  }

  function formatDayHeading(key) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      }).format(parseDayKey(key));
    } catch {
      return key;
    }
  }

  // ——— Persistence ———
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: 1, days: {} };
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return { version: 1, days: {} };
      return { version: 1, days: data.days && typeof data.days === 'object' ? data.days : {} };
    } catch {
      return { version: 1, days: {} };
    }
  }

  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function getDayMarkers(store, key) {
    return Array.isArray(store.days[key]) ? store.days[key] : [];
  }

  function setDayMarkers(store, key, markers) {
    if (!markers.length) {
      delete store.days[key];
    } else {
      store.days[key] = markers;
    }
    saveStore(store);
  }

  function uid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  // ——— Coordinate mapping ———
  /** Client point → grid coords (-3..+3), snapped lightly to 0.05 */
  function pointToXY(gridEl, clientX, clientY) {
    const rect = gridEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const nx = (clientX - rect.left) / rect.width;  // 0..1 left→right
    const ny = (clientY - rect.top) / rect.height;  // 0..1 top→bottom
    let x = nx * (RANGE * 2) - RANGE;
    let y = RANGE - ny * (RANGE * 2);
    x = Math.max(-RANGE, Math.min(RANGE, x));
    y = Math.max(-RANGE, Math.min(RANGE, y));
    const snap = (v) => Math.round(v * 20) / 20;
    return { x: snap(x), y: snap(y) };
  }

  function xyToPercent(x, y) {
    const left = ((x + RANGE) / (RANGE * 2)) * 100;
    const top = ((RANGE - y) / (RANGE * 2)) * 100;
    return { left, top };
  }

  // ——— State ———
  let store = loadStore();
  let currentDay = dayKeyFromDate();
  /** @type {'create'|'view'|'edit'|null} */
  let modalMode = null;
  /** @type {Marker|null} */
  let activeMarker = null;
  /** Pending create coords */
  let pendingXY = null;

  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_TOLERANCE = 10;
  let gridPress = null;
  let gridPressTimer = null;

  // ——— DOM ———
  const grid = $('#grid');
  const markersEl = $('#markers');
  const markerList = $('#marker-list');
  const emptyState = $('#empty-state');
  const dayPicker = $('#day-picker');
  const dayMeta = $('#day-meta');
  const modal = $('#modal');
  const modalTitle = $('#modal-title');
  const modalSub = $('#modal-sub');
  const noteInput = $('#note-input');
  const viewNote = $('#view-note');
  const viewTime = $('#view-time');
  const fieldView = $('#field-view');
  const fieldEdit = $('#field-edit');
  const actionsCreate = $('#actions-create');
  const actionsView = $('#actions-view');
  const actionsEdit = $('#actions-edit');
  const toastEl = $('#toast');

  // Build axis labels & grid lines once
  function buildChrome() {
    const ticks = [-3, -2, -1, 0, 1, 2, 3];
    const top = $('#x-labels-top');
    const bot = $('#x-labels-bot');
    const yTicks = $('#y-ticks');
    top.innerHTML = '';
    bot.innerHTML = '';
    yTicks.innerHTML = '';
    ticks.forEach((t) => {
      const label = t > 0 ? `+${t}` : String(t);
      const a = document.createElement('span');
      a.textContent = label;
      top.appendChild(a);
      const b = document.createElement('span');
      b.textContent = label;
      bot.appendChild(b);
    });
    // Y ticks top→bottom: +3..-3
    [...ticks].reverse().forEach((t) => {
      const s = document.createElement('span');
      s.textContent = t > 0 ? `+${t}` : String(t);
      yTicks.appendChild(s);
    });

    const lines = $('#grid-lines');
    lines.innerHTML = '';
    for (let i = 0; i <= 6; i++) {
      const pct = (i / 6) * 100;
      const h = document.createElement('div');
      h.className = 'hline' + (i === 3 ? ' axis' : '');
      h.style.top = pct + '%';
      lines.appendChild(h);
      const v = document.createElement('div');
      v.className = 'vline' + (i === 3 ? ' axis' : '');
      v.style.left = pct + '%';
      lines.appendChild(v);
    }
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function markersForDay() {
    return getDayMarkers(store, currentDay).slice().sort((a, b) => a.n - b.n);
  }

  function nextNumber() {
    const ms = markersForDay();
    return ms.length ? Math.max(...ms.map((m) => m.n)) + 1 : 1;
  }

  function renderMarkers() {
    const ms = markersForDay();
    markersEl.innerHTML = '';
    ms.forEach((m) => {
      const { left, top } = xyToPercent(m.x, m.y);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'marker' + (activeMarker && activeMarker.id === m.id ? ' active' : '');
      btn.style.left = left + '%';
      btn.style.top = top + '%';
      btn.dataset.id = m.id;
      btn.setAttribute('aria-label', `Marker ${m.n} at ${fmtXY(m.x, m.y)}`);
      btn.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="num">${m.n}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openView(m);
      });
      markersEl.appendChild(btn);
    });

    // List
    markerList.innerHTML = '';
    if (!ms.length) {
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      ms.forEach((m) => {
        const li = document.createElement('li');
        if (activeMarker && activeMarker.id === m.id) li.classList.add('active');
        li.innerHTML = `
          <div class="badge">${m.n}</div>
          <div class="meta">
            <div class="coords">${fmtXY(m.x, m.y)} · ${zoneLabel(m.x, m.y)}</div>
            <div class="note-preview">${escapeHtml(m.note || '(no note)')}</div>
          </div>
          <div class="time">${escapeHtml(formatFriendly(m.createdAt))}</div>`;
        li.addEventListener('click', () => openView(m));
        markerList.appendChild(li);
      });
    }

    dayMeta.textContent = `${ms.length} marker${ms.length === 1 ? '' : 's'} · ${formatDayHeading(currentDay)}`;
  }

  function fmtXY(x, y) {
    const fx = (v) => (v > 0 ? `+${v}` : String(v));
    return `(${fx(x)}, ${fx(y)})`;
  }

  function zoneLabel(x, y) {
    if (y > 0) {
      if (x < -1) return 'Nourished';
      if (x > 1) return 'Energized';
      return 'Connected';
    }
    if (y < 0) {
      if (x < -1) return 'Drained';
      if (x > 1) return 'Agitated';
      return 'Stuck';
    }
    return 'Neutral';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ——— Modal ———
  function setActions(mode) {
    actionsCreate.hidden = mode !== 'create';
    actionsView.hidden = mode !== 'view';
    actionsEdit.hidden = mode !== 'edit';
    fieldView.hidden = mode !== 'view';
    fieldEdit.hidden = mode === 'view';
  }

  function openModal() {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));
  }

  function closeModal() {
    modal.classList.remove('open');
    setTimeout(() => {
      modal.hidden = true;
      modalMode = null;
      pendingXY = null;
      activeMarker = null;
      renderMarkers();
    }, 180);
  }

  function openCreate(x, y) {
    modalMode = 'create';
    pendingXY = { x, y };
    activeMarker = null;
    modalTitle.textContent = `New marker #${nextNumber()}`;
    modalSub.textContent = `${fmtXY(x, y)} · ${zoneLabel(x, y)}`;
    noteInput.value = '';
    viewTime.textContent = formatFriendly(nowISO()) + ' (will save on confirm)';
    setActions('create');
    openModal();
    setTimeout(() => noteInput.focus(), 50);
    renderMarkers();
  }

  function openView(m) {
    modalMode = 'view';
    activeMarker = m;
    pendingXY = null;
    modalTitle.textContent = `Marker #${m.n}`;
    modalSub.textContent = `${fmtXY(m.x, m.y)} · ${zoneLabel(m.x, m.y)}`;
    viewNote.textContent = m.note || '(no note)';
    let timeText = formatFriendly(m.createdAt);
    if (m.updatedAt && m.updatedAt !== m.createdAt) {
      timeText += `\nEdited ${formatFriendly(m.updatedAt)}`;
    }
    viewTime.textContent = timeText;
    setActions('view');
    openModal();
    renderMarkers();
  }

  function openEdit() {
    if (!activeMarker) return;
    modalMode = 'edit';
    modalTitle.textContent = `Edit marker #${activeMarker.n}`;
    noteInput.value = activeMarker.note || '';
    viewTime.textContent = formatFriendly(activeMarker.createdAt);
    setActions('edit');
    setTimeout(() => noteInput.focus(), 50);
  }

  function saveCreate() {
    if (!pendingXY) return;
    const m = {
      id: uid(),
      n: nextNumber(),
      x: pendingXY.x,
      y: pendingXY.y,
      note: noteInput.value.trim(),
      createdAt: nowISO()
    };
    const list = markersForDay().concat(m);
    setDayMarkers(store, currentDay, list);
    store = loadStore();
    activeMarker = m;
    toast(`Saved marker #${m.n}`);
    closeModalQuick();
    openView(m);
  }

  function saveEdit() {
    if (!activeMarker) return;
    const list = markersForDay().map((m) => {
      if (m.id !== activeMarker.id) return m;
      return {
        ...m,
        note: noteInput.value.trim(),
        updatedAt: nowISO()
      };
    });
    setDayMarkers(store, currentDay, list);
    store = loadStore();
    const updated = getDayMarkers(store, currentDay).find((m) => m.id === activeMarker.id);
    toast('Note updated');
    if (updated) openView(updated);
    else closeModalQuick();
  }

  function deleteActive() {
    if (!activeMarker) return;
    if (!confirm(`Delete marker #${activeMarker.n}?`)) return;
    const list = markersForDay().filter((m) => m.id !== activeMarker.id);
    setDayMarkers(store, currentDay, list);
    store = loadStore();
    toast(`Deleted marker #${activeMarker.n}`);
    activeMarker = null;
    closeModalQuick();
    renderMarkers();
  }

  function closeModalQuick() {
    modal.classList.remove('open');
    modal.hidden = true;
    modalMode = null;
    pendingXY = null;
  }

  // ——— Day switcher ———
  function setDay(key) {
    currentDay = key;
    dayPicker.value = key;
    activeMarker = null;
    closeModalQuick();
    renderMarkers();
  }

  // ——— Grid interaction ———
  function clearGridPress() {
    if (gridPressTimer !== null) {
      clearTimeout(gridPressTimer);
      gridPressTimer = null;
    }
    gridPress = null;
  }

  function onGridPointerDown(e) {
    // Markers handle their own short taps; never start placement on top of one.
    if (e.target.closest('.marker')) return;
    if (e.button !== undefined && e.button !== 0) return;

    const xy = pointToXY(grid, e.clientX, e.clientY);
    if (!xy) return;

    clearGridPress();
    gridPress = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, xy };
    gridPressTimer = setTimeout(() => {
      if (!gridPress || gridPress.pointerId !== e.pointerId) return;
      gridPressTimer = null;
      openCreate(gridPress.xy.x, gridPress.xy.y);
    }, LONG_PRESS_MS);
  }

  function onGridPointerMove(e) {
    if (!gridPress || gridPress.pointerId !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - gridPress.startX, e.clientY - gridPress.startY);
    if (moved > LONG_PRESS_MOVE_TOLERANCE) clearGridPress();
  }

  function onGridPointerUp(e) {
    if (gridPress && gridPress.pointerId === e.pointerId) clearGridPress();
  }

  function onGridPointerCancel(e) {
    if (gridPress && gridPress.pointerId === e.pointerId) clearGridPress();
  }

  // ——— Export / Import ———
  function exportJSON() {
    const payload = {
      app: 'ANS Orientation Tracker',
      owner: 'Cal Harris Jr.',
      timezone: TZ,
      exportedAt: nowISO(),
      ...loadStore()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = dayKeyFromDate();
    a.href = URL.createObjectURL(blob);
    a.download = `ans-orientation-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Exported JSON');
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data !== 'object' || !data.days || typeof data.days !== 'object') {
          throw new Error('Invalid file: missing days');
        }
        // Merge days (imported markers replace same-day data only if confirmed)
        const incoming = data.days;
        const keys = Object.keys(incoming);
        if (!keys.length) {
          toast('No days in file');
          return;
        }
        const merge = confirm(
          `Import ${keys.length} day(s)?\nOK = merge (replace overlapping days)\nCancel = abort`
        );
        if (!merge) return;
        store = loadStore();
        keys.forEach((k) => {
          if (Array.isArray(incoming[k])) store.days[k] = incoming[k];
        });
        saveStore(store);
        store = loadStore();
        renderMarkers();
        toast('Import complete');
      } catch (err) {
        alert('Could not import: ' + (err && err.message ? err.message : 'invalid JSON'));
      }
    };
    reader.readAsText(file);
  }

  // ——— Wire events ———
  function bind() {
    grid.addEventListener('pointerdown', onGridPointerDown);
    grid.addEventListener('pointermove', onGridPointerMove);
    grid.addEventListener('pointerup', onGridPointerUp);
    grid.addEventListener('pointercancel', onGridPointerCancel);
    grid.addEventListener('pointerleave', clearGridPress);
    grid.addEventListener('contextmenu', (e) => e.preventDefault());

    $('#btn-prev').addEventListener('click', () => setDay(shiftDayKey(currentDay, -1)));
    $('#btn-next').addEventListener('click', () => setDay(shiftDayKey(currentDay, 1)));
    dayPicker.addEventListener('change', () => {
      if (dayPicker.value) setDay(dayPicker.value);
    });

    $('#btn-cancel').addEventListener('click', () => {
      closeModalQuick();
      activeMarker = null;
      renderMarkers();
    });
    $('#btn-save').addEventListener('click', saveCreate);
    $('#btn-close').addEventListener('click', () => {
      closeModalQuick();
      activeMarker = null;
      renderMarkers();
    });
    $('#btn-edit').addEventListener('click', openEdit);
    $('#btn-edit-cancel').addEventListener('click', () => {
      if (activeMarker) openView(activeMarker);
    });
    $('#btn-edit-save').addEventListener('click', saveEdit);
    $('#btn-delete').addEventListener('click', deleteActive);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModalQuick();
        activeMarker = null;
        renderMarkers();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) {
        closeModalQuick();
        activeMarker = null;
        renderMarkers();
      }
    });

    $('#btn-export').addEventListener('click', exportJSON);
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importJSON(f);
      e.target.value = '';
    });
  }

  // ——— Service worker ———
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // Only register when served over http(s) — file:// won't work
    if (!/^https?:$/.test(location.protocol)) return;

    const reloadKey = 'ans-orientation-sw-reloaded';
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      let alreadyReloaded = false;
      try {
        alreadyReloaded = sessionStorage.getItem(reloadKey) === '1';
      } catch {
        // Ignore storage restrictions; the in-memory guard still prevents loops.
      }
      if (alreadyReloaded) return;

      reloading = true;
      try {
        sessionStorage.setItem(reloadKey, '1');
      } catch {
        // Ignore storage restrictions.
      }
      toast('Updated — refreshing');
      setTimeout(() => window.location.reload(), 150);
    });

    navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update())
      .catch(() => {
        /* offline / first load may fail quietly */
      });
  }

  // ——— Init ———
  buildChrome();
  bind();
  dayPicker.value = currentDay;
  renderMarkers();
  registerSW();
})();
