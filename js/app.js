/**
 * ANS Orientation Tracker — Cal Harris Jr.
 * Per-day markers on a -3..+3 grid, persisted in localStorage.
 */
(() => {
  'use strict';

  const APP_VERSION = '1.8';
  const STORAGE_KEY = 'ans-orientation-tracker:v1';
  const VIEW_KEY = 'ans-orientation-tracker:dayView';
  const TZ = 'America/Los_Angeles';
  const RANGE = 3; // axes -3..+3
  /** Normalized-plot offset (~0.07) → grid-y lift for Duplicate. */
  const DUP_OFFSET_NORM = 0.07;

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

  function loadDayView() {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'list' ? 'list' : 'chart';
    } catch {
      return 'chart';
    }
  }

  function applyDayView(view) {
    dayView = view === 'list' ? 'list' : 'chart';
    try { localStorage.setItem(VIEW_KEY, dayView); } catch { /* private mode */ }
    document.documentElement.classList.toggle('view-list', dayView === 'list');
    document.body.classList.toggle('view-list', dayView === 'list');
    const appEl = document.querySelector('.app');
    if (appEl) appEl.classList.toggle('view-list', dayView === 'list');
    if (dayViewSelect) dayViewSelect.value = dayView;
    const title = $('#marker-panel-title');
    if (title) {
      title.textContent = dayView === 'list' ? 'Markers (list)' : 'Markers today';
    }
  }

  // ——— Coordinate mapping ———
  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function clampRange(value) {
    return Math.max(-RANGE, Math.min(RANGE, value));
  }

  function snapCoord(v) {
    return Math.round(v * 20) / 20;
  }

  /** Client point → normalized plot position (0..1, left→right/top→bottom). */
  function pointToNormalized(gridEl, clientX, clientY) {
    const rect = gridEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height)
    };
  }

  /** Normalized plot position → grid coords (-3..+3), snapped lightly to 0.05. */
  function normalizedToXY(position) {
    return {
      x: snapCoord(position.x * (RANGE * 2) - RANGE),
      y: snapCoord(RANGE - position.y * (RANGE * 2))
    };
  }

  /** Client point → grid coords (-3..+3), clamped to the plot bounds. */
  function pointToXY(gridEl, clientX, clientY) {
    const position = pointToNormalized(gridEl, clientX, clientY);
    return position ? normalizedToXY(position) : null;
  }

  function xyToPercent(x, y) {
    const left = ((x + RANGE) / (RANGE * 2)) * 100;
    const top = ((RANGE - y) / (RANGE * 2)) * 100;
    return { left, top };
  }

  // ——— State ———
  let store = loadStore();
  let currentDay = dayKeyFromDate();
  /** @type {'chart'|'list'} */
  let dayView = 'chart';
  /** @type {'create'|'edit'|null} */
  let modalMode = null;
  /** @type {Marker|null} */
  let activeMarker = null;
  /** Draft x/y while modal is open (create or edit). */
  let draftXY = null;

  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_TOLERANCE = 10;
  let gridPress = null;
  let gridPressTimer = null;
  let markerPress = null;
  let markerPressTimer = null;
  let movingMarker = null;
  let skipMarkerClickId = null;

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
  const viewTime = $('#view-time');
  const sliderThreat = $('#slider-threat');
  const sliderBand = $('#slider-band');
  const bandLabelsOptimal = $('#band-labels-optimal');
  const bandLabelsDefensive = $('#band-labels-defensive');
  const bandLabelsNeutral = $('#band-labels-neutral');
  const miniDot = $('#mini-dot');
  const dayViewSelect = $('#day-view');
  const gridCard = document.querySelector('.grid-card');
  const markerPanel = $('#marker-panel');
  const toastEl = $('#toast');
  const appVersionEl = $('#app-version');
  if (appVersionEl) appVersionEl.textContent = `v${APP_VERSION}`;

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

  function markerById(id) {
    return getDayMarkers(store, currentDay).find((m) => m.id === id) || null;
  }

  function renderMarkers() {
    const ms = markersForDay();
    markersEl.innerHTML = '';
    ms.forEach((m) => {
      const pos =
        draftXY && activeMarker && activeMarker.id === m.id
          ? draftXY
          : { x: m.x, y: m.y };
      const { left, top } = xyToPercent(pos.x, pos.y);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'marker' + (activeMarker && activeMarker.id === m.id ? ' active' : '');
      if (movingMarker && movingMarker.id === m.id) btn.classList.add('moving');
      btn.style.left = left + '%';
      btn.style.top = top + '%';
      btn.dataset.id = m.id;
      btn.setAttribute('aria-label', `Marker ${m.n} at ${fmtXY(pos.x, pos.y)}`);
      btn.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="num">${m.n}</span>`;
      btn.addEventListener('pointerdown', (e) => onMarkerPointerDown(e, m));
      btn.addEventListener('pointermove', onMarkerPointerMove);
      btn.addEventListener('pointerup', onMarkerPointerUp);
      btn.addEventListener('pointercancel', onMarkerPointerCancel);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (skipMarkerClickId === m.id) {
          skipMarkerClickId = null;
          return;
        }
        if (movingMarker) return;
        openEdit(m);
      });
      markersEl.appendChild(btn);
    });

    // Create-flow preview (unsaved)
    if (modalMode === 'create' && draftXY) {
      const { left, top } = xyToPercent(draftXY.x, draftXY.y);
      const preview = document.createElement('div');
      preview.className = 'marker preview';
      preview.style.left = left + '%';
      preview.style.top = top + '%';
      preview.setAttribute('aria-hidden', 'true');
      const n = nextNumber();
      preview.innerHTML = `<span class="dot"></span><span class="num">${n}</span>`;
      markersEl.appendChild(preview);
    }

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
        li.addEventListener('click', () => openEdit(m));
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

  // ——— Sliders ↔ draft position ———
  /** Cross-fade horizontal band zone titles with Sense of threat (chart Y −3…+3). */
  function updateBandLabelOpacity(y) {
    const yy = Number(y);
    // Neutral peaks at center; fades toward ±1.2 (smooth mid-band visibility)
    const neutralOpacity = 1 - Math.min(1, Math.abs(yy) / 1.2);
    const optimalOpacity = yy > 0 ? clamp01(yy / RANGE) : 0;
    const defensiveOpacity = yy < 0 ? clamp01(-yy / RANGE) : 0;
    if (bandLabelsNeutral) bandLabelsNeutral.style.opacity = String(neutralOpacity);
    if (bandLabelsOptimal) bandLabelsOptimal.style.opacity = String(optimalOpacity);
    if (bandLabelsDefensive) bandLabelsDefensive.style.opacity = String(defensiveOpacity);
  }

  /** Sync mini-chart draft marker with current draftXY. */
  function updateMiniDot() {
    if (!miniDot || !draftXY) return;
    const { left, top } = xyToPercent(draftXY.x, draftXY.y);
    miniDot.style.left = left + '%';
    miniDot.style.top = top + '%';
  }

  function syncSlidersFromDraft() {
    if (!draftXY) return;
    sliderThreat.value = String(draftXY.y);
    sliderBand.value = String(draftXY.x);
    updateBandLabelOpacity(draftXY.y);
    updateMiniDot();
  }

  function updateModalSub() {
    if (!draftXY) {
      modalSub.textContent = '';
      return;
    }
    modalSub.textContent = `${fmtXY(draftXY.x, draftXY.y)} · ${zoneLabel(draftXY.x, draftXY.y)}`;
  }

  function applyDraftFromSliders() {
    const y = snapCoord(clampRange(Number(sliderThreat.value)));
    const x = snapCoord(clampRange(Number(sliderBand.value)));
    draftXY = { x, y };
    // Keep slider values snapped
    sliderThreat.value = String(y);
    sliderBand.value = String(x);
    updateBandLabelOpacity(y);
    updateModalSub();
    updateMiniDot();
    livePreviewPosition();
  }

  function livePreviewPosition() {
    if (!draftXY) return;
    if (modalMode === 'edit' && activeMarker) {
      setMarkerPositionPreview(activeMarker.id, draftXY);
      const btn = [...markersEl.querySelectorAll('.marker')].find(
        (el) => el.dataset.id === activeMarker.id
      );
      if (btn) {
        btn.setAttribute(
          'aria-label',
          `Marker ${activeMarker.n} at ${fmtXY(draftXY.x, draftXY.y)}`
        );
      }
    } else if (modalMode === 'create') {
      // Re-render to move/create the preview ghost
      const preview = markersEl.querySelector('.marker.preview');
      if (preview) {
        const { left, top } = xyToPercent(draftXY.x, draftXY.y);
        preview.style.left = left + '%';
        preview.style.top = top + '%';
      } else {
        renderMarkers();
      }
    }
  }

  // ——— Modal ———
  function openModal() {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));
  }

  function dismissModal() {
    // X / Escape / backdrop: discard draft; do not save
    modal.classList.remove('open');
    modal.hidden = true;
    modalMode = null;
    draftXY = null;
    activeMarker = null;
    renderMarkers();
  }

  function closeModalQuick() {
    modal.classList.remove('open');
    modal.hidden = true;
    modalMode = null;
    draftXY = null;
  }

  function openCreate(x, y) {
    modalMode = 'create';
    activeMarker = null;
    draftXY = { x: snapCoord(x), y: snapCoord(y) };
    modalTitle.textContent = `New marker #${nextNumber()}`;
    noteInput.value = '';
    viewTime.textContent = formatFriendly(nowISO()) + ' (will save on confirm)';
    syncSlidersFromDraft();
    updateModalSub();
    openModal();
    renderMarkers();
    setTimeout(() => noteInput.focus(), 50);
  }

  function openEdit(m) {
    modalMode = 'edit';
    activeMarker = m;
    draftXY = { x: m.x, y: m.y };
    modalTitle.textContent = `Edit marker #${m.n}`;
    noteInput.value = m.note || '';
    let timeText = formatFriendly(m.createdAt);
    if (m.updatedAt && m.updatedAt !== m.createdAt) {
      timeText += `\nEdited ${formatFriendly(m.updatedAt)}`;
    }
    viewTime.textContent = timeText;
    syncSlidersFromDraft();
    updateModalSub();
    openModal();
    renderMarkers();
    setTimeout(() => noteInput.focus(), 50);
  }

  function persistMarker(marker) {
    const list = markersForDay();
    const idx = list.findIndex((m) => m.id === marker.id);
    let next;
    if (idx === -1) {
      next = list.concat(marker);
    } else {
      next = list.slice();
      next[idx] = marker;
    }
    setDayMarkers(store, currentDay, next);
    store = loadStore();
    return markerById(marker.id);
  }

  function saveCurrent() {
    if (!draftXY) return null;
    const note = noteInput.value.trim();
    if (modalMode === 'create') {
      const m = {
        id: uid(),
        n: nextNumber(),
        x: draftXY.x,
        y: draftXY.y,
        note,
        createdAt: nowISO()
      };
      const saved = persistMarker(m);
      toast(`Saved marker #${saved.n}`);
      return saved;
    }
    if (modalMode === 'edit' && activeMarker) {
      const updated = persistMarker({
        ...activeMarker,
        x: draftXY.x,
        y: draftXY.y,
        note,
        updatedAt: nowISO()
      });
      toast(`Saved marker #${updated.n}`);
      return updated;
    }
    return null;
  }

  function onSave() {
    const saved = saveCurrent();
    if (!saved) return;
    closeModalQuick();
    activeMarker = null;
    renderMarkers();
  }

  function onDelete() {
    if (modalMode === 'create') {
      // Unsaved create: discard
      dismissModal();
      toast('Discarded');
      return;
    }
    if (!activeMarker) return;
    if (!confirm(`Delete marker #${activeMarker.n}?`)) return;
    const n = activeMarker.n;
    const list = markersForDay().filter((m) => m.id !== activeMarker.id);
    setDayMarkers(store, currentDay, list);
    store = loadStore();
    toast(`Deleted marker #${n}`);
    closeModalQuick();
    activeMarker = null;
    renderMarkers();
  }

  function duplicateYAbove(y) {
    const lift = DUP_OFFSET_NORM * (RANGE * 2); // ≈ 0.42
    return snapCoord(Math.min(RANGE, y + lift));
  }

  function onDuplicate() {
    if (!draftXY) return;
    // Ensure the current marker exists (save create/edit draft first)
    const source = saveCurrent();
    if (!source) return;

    const dup = {
      id: uid(),
      n: nextNumber(),
      x: source.x,
      y: duplicateYAbove(source.y),
      note: source.note || '',
      createdAt: nowISO()
    };
    const saved = persistMarker(dup);
    toast(`Duplicated → #${saved.n}`);
    // Stay in edit on the new duplicate
    openEdit(saved);
  }

  // ——— Day switcher ———
  function setDay(key) {
    currentDay = key;
    dayPicker.value = key;
    activeMarker = null;
    draftXY = null;
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

  function clearMarkerPressTimer() {
    if (markerPressTimer !== null) {
      clearTimeout(markerPressTimer);
      markerPressTimer = null;
    }
  }

  function setMarkerPositionPreview(id, xy) {
    const btn = [...markersEl.querySelectorAll('.marker')].find((el) => el.dataset.id === id);
    if (!btn) return;
    const { left, top } = xyToPercent(xy.x, xy.y);
    btn.style.left = left + '%';
    btn.style.top = top + '%';
    btn.setAttribute('aria-label', `Marker ${markerById(id)?.n || ''} at ${fmtXY(xy.x, xy.y)}`);
  }

  function persistMarkerPosition(id, xy) {
    const current = markerById(id);
    if (!current || !xy) return;
    if (current.x === xy.x && current.y === xy.y) {
      renderMarkers();
      return;
    }
    const list = getDayMarkers(store, currentDay).map((m) =>
      m.id === id ? { ...m, x: xy.x, y: xy.y, updatedAt: nowISO() } : m
    );
    setDayMarkers(store, currentDay, list);
    store = loadStore();
    const updated = markerById(id);
    if (activeMarker && activeMarker.id === id) {
      activeMarker = updated;
      draftXY = { x: updated.x, y: updated.y };
      syncSlidersFromDraft();
      updateModalSub();
    }
    renderMarkers();
    toast(`Moved marker #${updated ? updated.n : current.n}`);
  }

  function endMarkerDrag(savePosition) {
    const moving = movingMarker;
    const state = markerPress;
    clearMarkerPressTimer();
    markerPress = null;
    movingMarker = null;
    grid.classList.remove('marker-moving');
    if (state && state.element && state.element.hasPointerCapture?.(state.pointerId)) {
      try { state.element.releasePointerCapture(state.pointerId); } catch { /* already released */ }
    }
    if (moving && savePosition) persistMarkerPosition(moving.id, moving.lastXY);
    else renderMarkers();
  }

  function startMarkerDrag() {
    if (!markerPress || markerPress.moved) return;
    const state = markerPress;
    const marker = markerById(state.id);
    if (!marker) return;
    markerPressTimer = null;
    state.dragging = true;
    movingMarker = { id: marker.id, lastXY: { x: marker.x, y: marker.y } };
    activeMarker = marker;
    grid.classList.add('marker-moving');
    state.element.classList.add('moving');
    try { state.element.setPointerCapture(state.pointerId); } catch { /* unsupported */ }
  }

  function onMarkerPointerDown(e, marker) {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    clearGridPress();
    clearMarkerPressTimer();
    markerPress = {
      pointerId: e.pointerId,
      id: marker.id,
      startX: e.clientX,
      startY: e.clientY,
      element: e.currentTarget,
      dragging: false,
      moved: false
    };
    markerPressTimer = setTimeout(startMarkerDrag, LONG_PRESS_MS);
  }

  function onMarkerPointerMove(e) {
    if (!markerPress || markerPress.pointerId !== e.pointerId) return;
    const state = markerPress;
    const moved = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
    if (!state.dragging && moved > LONG_PRESS_MOVE_TOLERANCE) {
      state.moved = true;
      clearMarkerPressTimer();
      skipMarkerClickId = state.id;
      return;
    }
    if (!state.dragging || !movingMarker) return;
    const xy = pointToXY(grid, e.clientX, e.clientY);
    if (!xy) return;
    e.preventDefault();
    movingMarker.lastXY = xy;
    setMarkerPositionPreview(state.id, xy);
  }

  function onMarkerPointerUp(e) {
    if (!markerPress || markerPress.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const state = markerPress;
    if (state.dragging) {
      const xy = pointToXY(grid, e.clientX, e.clientY);
      if (xy && movingMarker) movingMarker.lastXY = xy;
      e.preventDefault();
      endMarkerDrag(true);
      return;
    }
    clearMarkerPressTimer();
    markerPress = null;
    if (state.moved) skipMarkerClickId = state.id;
  }

  function onMarkerPointerCancel(e) {
    if (!markerPress || markerPress.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const wasDragging = markerPress.dragging;
    endMarkerDrag(wasDragging);
    if (!wasDragging) skipMarkerClickId = null;
  }

  function onGridPointerDown(e) {
    // Markers handle their own taps and long-press moves.
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

    if (dayViewSelect) {
      dayViewSelect.addEventListener('change', () => {
        applyDayView(dayViewSelect.value);
      });
    }

    $('#btn-modal-close').addEventListener('click', dismissModal);
    $('#btn-save').addEventListener('click', onSave);
    $('#btn-delete').addEventListener('click', onDelete);
    $('#btn-duplicate').addEventListener('click', onDuplicate);

    sliderThreat.addEventListener('input', applyDraftFromSliders);
    sliderBand.addEventListener('input', applyDraftFromSliders);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) dismissModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) dismissModal();
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

    // skipWaiting() + clients.claim() in sw.js makes updates take control now;
    // reload once for the new cached HTML/JS/CSS to become visible.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
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
  dayView = loadDayView();
  applyDayView(dayView);
  renderMarkers();
  registerSW();
})();
