/**
 * ANS Orientation Tracker — Cal Harris Jr.
 * Per-day markers on a -3..+3 grid; localStorage + optional Google Drive appData sync.
 */
(() => {
  'use strict';

  const APP_VERSION = '1.10';
  const STORAGE_KEY = 'ans-orientation-tracker:v1';
  const VIEW_KEY = 'ans-orientation-tracker:dayView';
  const GGL_CLIENT_KEY = 'ans_ggl_client_id';
  const GGL_TOK_KEY = 'ans_ggl_tok';
  const GGL_FILE_KEY = 'ans_ggl_file_id';
  const DRIVE_FILE_NAME = 'ans-orientation.json';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email';
  const UPLOAD_DEBOUNCE_MS = 800;
  const DELETE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
  const TZ = 'America/Los_Angeles';
  const RANGE = 3;
  /** Normalized-plot offset (~0.07) → grid-y lift for Duplicate. */
  const DUP_OFFSET_NORM = 0.07;

  /** @typedef {{ id: string, n: number, x: number, y: number, note: string, createdAt: string, updatedAt?: string }} Marker */
  /** @typedef {{ version: number, updatedAt?: string, days: Record<string, Marker[]>, deleted?: Record<string, string> }} Store */

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
  function emptyStore() {
    return { version: 1, updatedAt: nowISO(), days: {}, deleted: {} };
  }

  function normalizeStore(data) {
    if (!data || typeof data !== 'object') return emptyStore();
    const days = data.days && typeof data.days === 'object' ? data.days : {};
    const deleted =
      data.deleted && typeof data.deleted === 'object' ? { ...data.deleted } : {};
    const cleanedDays = {};
    Object.keys(days).forEach((k) => {
      if (Array.isArray(days[k]) && days[k].length) cleanedDays[k] = days[k];
    });
    return {
      version: 1,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : nowISO(),
      days: cleanedDays,
      deleted
    };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyStore();
      return normalizeStore(JSON.parse(raw));
    } catch {
      return emptyStore();
    }
  }

  function saveStore(store, opts = {}) {
    const next = normalizeStore(store);
    if (!opts.keepUpdatedAt) next.updatedAt = nowISO();
    // Omit empty days
    Object.keys(next.days).forEach((k) => {
      if (!Array.isArray(next.days[k]) || !next.days[k].length) delete next.days[k];
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (!opts.skipUpload) scheduleUpload();
    return next;
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
    store = saveStore(store);
    return store;
  }

  function markerTimestamp(m) {
    if (!m) return 0;
    const t = Date.parse(m.updatedAt || m.createdAt || 0);
    return Number.isFinite(t) ? t : 0;
  }

  function pruneDeleted(deleted) {
    const cutoff = Date.now() - DELETE_RETENTION_MS;
    const out = {};
    Object.keys(deleted || {}).forEach((id) => {
      const t = Date.parse(deleted[id]);
      if (Number.isFinite(t) && t >= cutoff) out[id] = deleted[id];
    });
    return out;
  }

  /**
   * Merge two stores by marker id + tombstones.
   * Same id → keep later updatedAt/createdAt.
   * If deleted[ts] ≥ marker ts → drop marker.
   */
  function mergeStores(local, remote) {
    const a = normalizeStore(local);
    const b = normalizeStore(remote);

    const deleted = {};
    const allDel = new Set([
      ...Object.keys(a.deleted || {}),
      ...Object.keys(b.deleted || {})
    ]);
    allDel.forEach((id) => {
      const ta = Date.parse((a.deleted || {})[id] || 0) || 0;
      const tb = Date.parse((b.deleted || {})[id] || 0) || 0;
      deleted[id] = ta >= tb ? a.deleted[id] : b.deleted[id];
    });
    const prunedDeleted = pruneDeleted(deleted);

    /** @type {Record<string, { marker: Marker, day: string }>} */
    const best = {};
    function ingest(day, marker) {
      if (!marker || !marker.id) return;
      const prev = best[marker.id];
      if (!prev || markerTimestamp(marker) >= markerTimestamp(prev.marker)) {
        best[marker.id] = { marker, day };
      }
    }
    Object.keys(a.days).forEach((day) => {
      (a.days[day] || []).forEach((m) => ingest(day, m));
    });
    Object.keys(b.days).forEach((day) => {
      (b.days[day] || []).forEach((m) => ingest(day, m));
    });

    const days = {};
    Object.keys(best).forEach((id) => {
      const { marker, day } = best[id];
      const delTs = Date.parse(prunedDeleted[id] || 0);
      if (Number.isFinite(delTs) && delTs >= markerTimestamp(marker)) return;
      if (!days[day]) days[day] = [];
      days[day].push(marker);
    });

    Object.keys(days).forEach((d) => {
      days[d].sort((x, y) => (x.n || 0) - (y.n || 0));
    });

    const updatedAtA = Date.parse(a.updatedAt || 0) || 0;
    const updatedAtB = Date.parse(b.updatedAt || 0) || 0;
    const updatedAt = new Date(Math.max(updatedAtA, updatedAtB, Date.now())).toISOString();

    return normalizeStore({ version: 1, updatedAt, days, deleted: prunedDeleted });
  }

  function storesEqualish(a, b) {
    try {
      return JSON.stringify(normalizeStore(a)) === JSON.stringify(normalizeStore(b));
    } catch {
      return false;
    }
  }

  function localHasExtra(local, remote, merged) {
    // Re-upload if local contributed anything beyond remote
    return !storesEqualish(merged, remote);
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

  function pointToNormalized(gridEl, clientX, clientY) {
    const rect = gridEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height)
    };
  }

  function normalizedToXY(position) {
    return {
      x: snapCoord(position.x * (RANGE * 2) - RANGE),
      y: snapCoord(RANGE - position.y * (RANGE * 2))
    };
  }

  function pointToXY(gridEl, clientX, clientY) {
    const position = pointToNormalized(gridEl, clientX, clientY);
    return position ? normalizedToXY(position) : null;
  }

  function xyToPercent(x, y) {
    const left = ((x + RANGE) / (RANGE * 2)) * 100;
    const top = ((RANGE - y) / (RANGE * 2)) * 100;
    return { left, top };
  }

  // ——— Google auth / Drive ———
  let tokenClient = null;
  let syncBusy = false;
  let uploadTimer = null;
  let uploadQueued = false;
  /** @type {'idle'|'syncing'|'synced'|'signin'|'offline'|'error'} */
  let syncState = 'idle';

  function getClientId() {
    return (localStorage.getItem(GGL_CLIENT_KEY) || '').trim();
  }

  function saveClientId(id) {
    localStorage.setItem(GGL_CLIENT_KEY, id.trim());
  }

  function loadTok() {
    try {
      return JSON.parse(localStorage.getItem(GGL_TOK_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function saveTok(t) {
    if (!t) localStorage.removeItem(GGL_TOK_KEY);
    else localStorage.setItem(GGL_TOK_KEY, JSON.stringify(t));
  }

  function isSignedIn() {
    const t = loadTok();
    return !!(t && t.access_token);
  }

  function waitForGis(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) {
        resolve();
        return;
      }
      const start = Date.now();
      const iv = setInterval(() => {
        if (window.google && google.accounts && google.accounts.oauth2) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error('Google Sign-In script did not load'));
        }
      }, 50);
    });
  }

  function ensureTokenClient() {
    const clientId = getClientId();
    if (!clientId) throw new Error('Enter the Google OAuth Client ID first');
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      throw new Error('Google Sign-In is still loading — try again');
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: () => {}
    });
    return tokenClient;
  }

  function requestAccessToken(prompt) {
    return new Promise(async (resolve, reject) => {
      try {
        await waitForGis();
        ensureTokenClient();
        tokenClient.callback = (resp) => {
          if (resp.error) {
            reject(new Error(resp.error));
            return;
          }
          const exp = Date.now() + ((resp.expires_in || 3600) - 60) * 1000;
          const prev = loadTok() || {};
          const next = {
            access_token: resp.access_token,
            exp,
            email: prev.email || null
          };
          saveTok(next);
          resolve(next);
        };
        const opts = {};
        if (prompt) opts.prompt = prompt;
        else if (loadTok() && loadTok().access_token) opts.prompt = '';
        tokenClient.requestAccessToken(opts);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function fetchUserEmail(accessToken) {
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.email || null;
    } catch {
      return null;
    }
  }

  async function getAccessToken() {
    let t = loadTok();
    if (t && t.access_token && Date.now() < t.exp) return t.access_token;
    if (!getClientId()) return null;
    if (!navigator.onLine) return null;
    try {
      t = await requestAccessToken('');
      return t.access_token;
    } catch {
      return null;
    }
  }

  async function driveFetch(path, options = {}) {
    const token = await getAccessToken();
    if (!token) throw new Error('Not signed in');
    const headers = Object.assign({}, options.headers || {}, {
      Authorization: 'Bearer ' + token
    });
    const r = await fetch('https://www.googleapis.com' + path, {
      ...options,
      headers
    });
    if (r.status === 401) {
      // try one refresh
      try {
        await requestAccessToken('');
      } catch {
        saveTok(null);
        throw new Error('Session expired — sign in again');
      }
      const token2 = await getAccessToken();
      headers.Authorization = 'Bearer ' + token2;
      const r2 = await fetch('https://www.googleapis.com' + path, {
        ...options,
        headers
      });
      if (!r2.ok) throw new Error('Drive ' + r2.status + ' ' + (await r2.text()));
      return r2;
    }
    if (!r.ok) throw new Error('Drive ' + r.status + ' ' + (await r.text()));
    return r;
  }

  async function findDriveFileId() {
    const cached = localStorage.getItem(GGL_FILE_KEY);
    if (cached) return cached;
    const q = encodeURIComponent("name = '" + DRIVE_FILE_NAME + "'");
    const r = await driveFetch(
      '/drive/v3/files?spaces=appDataFolder&q=' + q + '&fields=files(id,name)&pageSize=10'
    );
    const j = await r.json();
    if (j.files && j.files.length) {
      localStorage.setItem(GGL_FILE_KEY, j.files[0].id);
      return j.files[0].id;
    }
    return null;
  }

  async function createDriveFile(content) {
    const metadata = {
      name: DRIVE_FILE_NAME,
      parents: ['appDataFolder']
    };
    const boundary = 'ans_orient_' + Date.now();
    const body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      content + '\r\n' +
      '--' + boundary + '--';
    const r = await driveFetch(
      '/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body
      }
    );
    const j = await r.json();
    if (j.id) localStorage.setItem(GGL_FILE_KEY, j.id);
    return j.id;
  }

  async function downloadDriveStore() {
    let id = await findDriveFileId();
    if (!id) return null;
    try {
      const r = await driveFetch('/drive/v3/files/' + encodeURIComponent(id) + '?alt=media');
      const body = await r.text();
      if (!body) return null;
      try {
        return normalizeStore(JSON.parse(body));
      } catch {
        return null;
      }
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (msg.includes('404')) {
        localStorage.removeItem(GGL_FILE_KEY);
        id = await findDriveFileId();
        if (!id) return null;
        const r2 = await driveFetch('/drive/v3/files/' + encodeURIComponent(id) + '?alt=media');
        const body2 = await r2.text();
        if (!body2) return null;
        try {
          return normalizeStore(JSON.parse(body2));
        } catch {
          return null;
        }
      }
      throw err;
    }
  }

  async function uploadDriveStore(storeObj) {
    const payload = JSON.stringify(normalizeStore(storeObj));
    let id = await findDriveFileId();
    if (!id) {
      await createDriveFile(payload);
      return;
    }
    try {
      await driveFetch(
        '/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        }
      );
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (msg.includes('404')) {
        localStorage.removeItem(GGL_FILE_KEY);
        await createDriveFile(payload);
        return;
      }
      throw err;
    }
  }

  function refreshSignInBanner() {
    const banner = $('#google-signin-banner');
    if (!banner) return;
    banner.hidden = isSignedIn();
  }

  function setSyncStatus(state, detail) {
    syncState = state;
    const el = $('#sync-status');
    const map = {
      idle: 'Local only',
      signin: 'Google · sign in',
      syncing: 'Google · syncing…',
      synced: 'Google · synced',
      offline: 'Offline · local only',
      error: detail ? 'Google · ' + detail : 'Google · error'
    };
    let label;
    if (!navigator.onLine) label = map.offline;
    else if (!isSignedIn() && state !== 'syncing') label = map.signin;
    else label = map[state] || map.idle;
    if (el) {
      el.textContent = label;
      const clickable = !isSignedIn() || state === 'signin' || state === 'error';
      el.classList.toggle('is-action', clickable);
      el.title = clickable ? 'Open Google sync' : (isSignedIn() ? 'Signed in — tap Sync for options' : label);
    }
    refreshSignInBanner();
  }

  function updateSettingsUI(msg) {
    const signedOut = $('#settings-signed-out');
    const signedIn = $('#settings-signed-in');
    const account = $('#settings-account');
    const clientInput = $('#ggl-client-id');
    const msgEl = $('#settings-msg');
    if (clientInput && document.activeElement !== clientInput) {
      clientInput.value = getClientId();
    }
    const on = isSignedIn();
    if (signedOut) signedOut.hidden = on;
    if (signedIn) signedIn.hidden = !on;
    if (account) {
      const t = loadTok();
      account.textContent = t && t.email ? 'Signed in as ' + t.email : 'Signed in with Google';
    }
    if (msgEl && msg !== undefined) msgEl.textContent = msg || '';
    setSyncStatus(on ? (syncState === 'synced' ? 'synced' : syncState) : 'signin');
    refreshSignInBanner();
  }

  function openSettings() {
    const sheet = $('#settings-sheet');
    if (!sheet) return;
    updateSettingsUI('');
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('open'));
  }

  function closeSettings() {
    const sheet = $('#settings-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    sheet.hidden = true;
  }

  function promptForClientId(msg) {
    openSettings();
    const input = $('#ggl-client-id');
    updateSettingsUI(msg || 'Paste the Google OAuth Client ID, then tap Sign in with Google.');
    if (input) {
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    }
  }

  async function signInWithGoogle() {
    const input = $('#ggl-client-id');
    const id = (input && input.value ? input.value : getClientId()).trim();
    if (!id) {
      promptForClientId('Enter the OAuth Client ID first (Google Cloud Console → Web client).');
      return;
    }
    saveClientId(id);
    // Ensure settings sheet can show progress even if launched from the top banner
    const sheet = $('#settings-sheet');
    if (sheet && sheet.hidden) {
      sheet.hidden = false;
      requestAnimationFrame(() => sheet.classList.add('open'));
    }
    updateSettingsUI('Opening Google…');
    try {
      await waitForGis();
      const tok = await requestAccessToken('consent');
      const email = await fetchUserEmail(tok.access_token);
      if (email) {
        const t = loadTok() || tok;
        t.email = email;
        saveTok(t);
      }
      updateSettingsUI('Signed in.');
      toast('Signed in with Google');
      setSyncStatus('syncing');
      refreshSignInBanner();
      await syncFromCloud({ reason: 'signin' });
    } catch (err) {
      openSettings();
      updateSettingsUI('Sign-in failed: ' + (err && err.message ? err.message : 'error'));
      setSyncStatus('error', 'sign-in failed');
    }
  }

  function signOutGoogle() {
    const t = loadTok();
    const clientId = getClientId();
    if (t && t.access_token && window.google && google.accounts && google.accounts.oauth2) {
      try {
        google.accounts.oauth2.revoke(t.access_token, () => {});
      } catch { /* ignore */ }
    }
    saveTok(null);
    localStorage.removeItem(GGL_FILE_KEY);
    tokenClient = null;
    void clientId;
    updateSettingsUI('Signed out.');
    setSyncStatus('signin');
    toast('Signed out');
  }

  function scheduleUpload() {
    uploadQueued = true;
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      uploadTimer = null;
      if (!uploadQueued) return;
      uploadQueued = false;
      pushLocalIfNeeded();
    }, UPLOAD_DEBOUNCE_MS);
  }

  async function pushLocalIfNeeded() {
    if (!isSignedIn() || !navigator.onLine) {
      setSyncStatus(isSignedIn() ? 'offline' : 'signin');
      return;
    }
    try {
      setSyncStatus('syncing');
      const local = loadStore();
      await uploadDriveStore(local);
      setSyncStatus('synced');
    } catch (err) {
      setSyncStatus('error', 'upload failed');
      console.warn('upload failed', err);
    }
  }

  async function syncFromCloud(opts = {}) {
    if (syncBusy) return;
    if (!isSignedIn()) {
      setSyncStatus('signin');
      if (opts.reason === 'manual') openSettings();
      return;
    }
    if (!navigator.onLine) {
      setSyncStatus('offline');
      if (opts.reason === 'manual') toast('Offline — local only');
      return;
    }
    syncBusy = true;
    setSyncStatus('syncing');
    try {
      const localBefore = loadStore();
      let remote = null;
      try {
        remote = await downloadDriveStore();
      } catch (err) {
        // missing file → seed
        if (String(err.message || '').includes('404')) remote = null;
        else throw err;
      }
      if (!remote) {
        await uploadDriveStore(localBefore);
        store = loadStore();
        setSyncStatus('synced');
        if (opts.reason === 'manual' || opts.reason === 'signin') toast('Cloud file created');
        updateSettingsUI(opts.reason === 'manual' ? 'Synced — seeded cloud file.' : undefined);
        return;
      }
      const merged = mergeStores(localBefore, remote);
      const needUpload = localHasExtra(localBefore, remote, merged);
      store = saveStore(merged, { keepUpdatedAt: true, skipUpload: true });
      if (needUpload || !storesEqualish(merged, remote)) {
        await uploadDriveStore(store);
      }
      renderMarkers();
      setSyncStatus('synced');
      if (opts.reason === 'manual') toast('Synced');
      updateSettingsUI(opts.reason === 'manual' ? 'Synced with Google Drive.' : undefined);
    } catch (err) {
      console.warn('sync failed', err);
      setSyncStatus('error', 'sync failed');
      if (opts.reason === 'manual' || opts.reason === 'signin') {
        updateSettingsUI('Sync failed: ' + (err && err.message ? err.message : 'error'));
        toast('Sync failed');
      }
    } finally {
      syncBusy = false;
    }
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
  const toastEl = $('#toast');
  const appVersionEl = $('#app-version');
  if (appVersionEl) appVersionEl.textContent = `v${APP_VERSION}`;

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

  function updateBandLabelOpacity(y) {
    const yy = Number(y);
    const neutralOpacity = 1 - Math.min(1, Math.abs(yy) / 1.2);
    const optimalOpacity = yy > 0 ? clamp01(yy / RANGE) : 0;
    const defensiveOpacity = yy < 0 ? clamp01(-yy / RANGE) : 0;
    if (bandLabelsNeutral) bandLabelsNeutral.style.opacity = String(neutralOpacity);
    if (bandLabelsOptimal) bandLabelsOptimal.style.opacity = String(optimalOpacity);
    if (bandLabelsDefensive) bandLabelsDefensive.style.opacity = String(defensiveOpacity);
  }

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

  function openModal() {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));
  }

  function dismissModal() {
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
    // Clear tombstone if re-creating same id (shouldn't happen) 
    if (store.deleted && store.deleted[marker.id]) {
      delete store.deleted[marker.id];
    }
    store = setDayMarkers(store, currentDay, next);
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
      dismissModal();
      toast('Discarded');
      return;
    }
    if (!activeMarker) return;
    if (!confirm(`Delete marker #${activeMarker.n}?`)) return;
    const n = activeMarker.n;
    const id = activeMarker.id;
    const list = markersForDay().filter((m) => m.id !== id);
    store.deleted = store.deleted || {};
    store.deleted[id] = nowISO();
    store = setDayMarkers(store, currentDay, list);
    toast(`Deleted marker #${n}`);
    closeModalQuick();
    activeMarker = null;
    renderMarkers();
  }

  function duplicateYAbove(y) {
    const lift = DUP_OFFSET_NORM * (RANGE * 2);
    return snapCoord(Math.min(RANGE, y + lift));
  }

  function onDuplicate() {
    if (!draftXY) return;
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
    openEdit(saved);
  }

  function setDay(key) {
    currentDay = key;
    dayPicker.value = key;
    activeMarker = null;
    draftXY = null;
    closeModalQuick();
    renderMarkers();
  }

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
    store = setDayMarkers(store, currentDay, list);
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
        const incoming = normalizeStore(data);
        const keys = Object.keys(incoming.days);
        if (!keys.length && !Object.keys(incoming.deleted || {}).length) {
          toast('No days in file');
          return;
        }
        const merge = confirm(
          `Import ${keys.length} day(s)?\nOK = merge with existing\nCancel = abort`
        );
        if (!merge) return;
        store = mergeStores(loadStore(), incoming);
        store = saveStore(store);
        renderMarkers();
        toast('Import complete');
      } catch (err) {
        alert('Could not import: ' + (err && err.message ? err.message : 'invalid JSON'));
      }
    };
    reader.readAsText(file);
  }

  function onSyncButton() {
    if (!isSignedIn()) {
      openSettings();
      return;
    }
    // Signed in: open settings (Sync now + Sign out) — also allow quick sync via long path
    openSettings();
  }

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
      if (e.key === 'Escape') {
        if (!$('#settings-sheet').hidden) closeSettings();
        else if (!modal.hidden) dismissModal();
      }
    });

    $('#btn-export').addEventListener('click', exportJSON);
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importJSON(f);
      e.target.value = '';
    });

    const btnSync = $('#btn-sync');
    if (btnSync) btnSync.addEventListener('click', onSyncButton);
    const btnSettingsClose = $('#btn-settings-close');
    if (btnSettingsClose) btnSettingsClose.addEventListener('click', closeSettings);
    const settingsSheet = $('#settings-sheet');
    if (settingsSheet) {
      settingsSheet.addEventListener('click', (e) => {
        if (e.target === settingsSheet) closeSettings();
      });
    }
    const btnSignIn = $('#btn-google-signin');
    if (btnSignIn) btnSignIn.addEventListener('click', () => signInWithGoogle());
    const btnSignInTop = $('#btn-google-signin-top');
    if (btnSignInTop) btnSignInTop.addEventListener('click', () => signInWithGoogle());
    const syncStatusBtn = $('#sync-status');
    if (syncStatusBtn) syncStatusBtn.addEventListener('click', () => {
      if (isSignedIn()) onSyncButton();
      else signInWithGoogle();
    });
    const btnSignOut = $('#btn-google-signout');
    if (btnSignOut) btnSignOut.addEventListener('click', () => signOutGoogle());
    const btnSyncNow = $('#btn-sync-now');
    if (btnSyncNow) btnSyncNow.addEventListener('click', () => syncFromCloud({ reason: 'manual' }));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        syncFromCloud({ reason: 'visibility' });
      }
    });
    window.addEventListener('online', () => {
      setSyncStatus(isSignedIn() ? 'syncing' : 'signin');
      if (uploadQueued || isSignedIn()) {
        syncFromCloud({ reason: 'online' });
      }
    });
    window.addEventListener('offline', () => setSyncStatus('offline'));
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return;

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      toast('Updated — refreshing');
      setTimeout(() => window.location.reload(), 150);
    });

    navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update())
      .catch(() => {});
  }

  // ——— Init ———
  buildChrome();
  bind();
  dayPicker.value = currentDay;
  dayView = loadDayView();
  applyDayView(dayView);
  renderMarkers();
  registerSW();
  setSyncStatus(isSignedIn() ? 'synced' : 'signin');
  updateSettingsUI();
  refreshSignInBanner();
  // Background sync on load
  if (isSignedIn() && navigator.onLine) {
    syncFromCloud({ reason: 'load' });
  }
})();
