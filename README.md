# ANS Orientation Tracker

A polished single-page Progressive Web App for tracking daily Autonomic Nervous System (ANS) orientation on a −3…+3 grid. Built for **Cal Harris Jr.**; any user can install it and sync across their own devices.

- **X axis:** left = inner functions (−), right = outer actions (+)
- **Y axis:** top = sense of safety (+), bottom = sense of threat (−), center = neutral
- **Optimal Zone (yellow, y > 0):** Nourished · Connected · Energized
- **Defensive Zone (red, y < 0):** Drained · Stuck · Agitated

Markers are numbered per calendar day, cached in `localStorage`, and optionally synced to **each user’s own Google Drive app data** (hidden `appDataFolder`). The app works offline after the first visit.

## Files

```
ans-orientation-tracker/
├── index.html
├── css/styles.css
├── js/app.js
├── sw.js
├── manifest.webmanifest
├── icons/          (PNG + SVG)
└── README.md
```

## GitHub Pages

The published app URL is:
**https://chi-65.github.io/ans-orientation-tracker/**
(repository name: `ans-orientation-tracker`). After each push, the service worker checks for the latest HTML, JavaScript, CSS, and manifest and refreshes the app on the next open.

## Serve statically

Any static file server works. From this folder:

```bash
# Python 3
python3 -m http.server 8080

# Node (if you have npx)
npx --yes serve -l 8080
```

Then open **http://localhost:8080** (or the address your server prints).

> Service workers and “Add to Home Screen” require `http://` or `https://` — not `file://`.
> Google Sign-In also requires an authorized JavaScript origin (see Data / Sync below).

## Install (Add to Home Screen)

### iPhone / iPad (Safari)

1. Open the app URL in **Safari**.
2. Tap the **Share** button.
3. Tap **Add to Home Screen**.
4. Confirm the name (**ANS Tracker**) and tap **Add**.

### Android (Chrome)

1. Open the app URL in Chrome.
2. Tap the menu (⋮) → **Install app** or **Add to Home Screen**.

### Desktop (Chrome / Edge)

1. Open the app URL.
2. Use the install icon in the address bar, or menu → **Install ANS Orientation Tracker**.

## How to use

1. Use **‹ ›** or the **date picker** to choose a day (each day has its own markers).
2. **Long-press an empty spot** on the grid → enter an optional note → **Save**.
3. **Tap an existing marker** (or a row in “Markers today”) → view note & timestamp → edit, move (long-press), duplicate, or delete.
4. **Export** downloads a JSON backup; **Import** merges days from a previously exported file.
5. **Sync** (cloud icon) opens settings to connect Google Drive for cross-device sync.

Timestamps are stored as ISO-8601 UTC and shown in **America/Los_Angeles** (PT).

## Data & multi-user sync (Google Drive)

- **Local cache key:** `ans-orientation-tracker:v1` in the browser’s `localStorage`
- Offline use always works on the device; clearing site data may wipe the local cache — use **Export** or keep Google sync on.
- **Per-user cloud file:** when signed in, markers sync to a private file `ans-orientation.json` in that user’s Google Drive **appDataFolder** (not visible in the normal Drive UI). Each Google account gets its own file; accounts do not share data.
- **Merge rules:** markers are keyed by `id`. For the same id, the later `updatedAt` / `createdAt` wins. Deletes write a tombstone (`deleted[id] = ISO`); a tombstone at or after the marker’s timestamp drops it. Tombstones older than 180 days are pruned on sync. Day keys are unioned; empty days are omitted.
- **When sync runs:** on app load, when the tab becomes visible, when the device comes back online, after local saves (debounced ~800ms upload), and via **Sync now** in settings.

### Connect Google (any user)

1. Tap the large **Sign in with Google to sync** button near the top (or the footer **Google · sign in** link, or header **Sync**).
2. Tap **Sign in with Google** and approve Drive app data access. The project OAuth Client ID is built into the app; Sync settings can optionally override it.
3. Markers then sync across that user’s phones/Macs while signed in to the same Google account.

### Google Cloud setup (project owner / Cal)

Create one OAuth 2.0 **Web application** client in Google Cloud Console for this PWA:

1. APIs & Services → enable **Google Drive API**.
2. Create OAuth client ID type **Web application**.
3. **Authorized JavaScript origins:**
   - `https://chi-65.github.io`
   - (optional for local testing) `http://localhost:8080`
4. Scopes used by the app (requested at sign-in):
   - `https://www.googleapis.com/auth/drive.appdata`
   - `https://www.googleapis.com/auth/userinfo.email` (account label in settings)
5. The Client ID is baked into the published app as the default (optional override in Sync settings). No client secret is embedded — GIS token client runs in the browser.
6. OAuth consent screen: add test users while in Testing, or publish the app when ready for broader use.

Users do **not** need their own Cloud project if they use the shared project Client ID; each person still signs into **their own** Google account and only sees their own appData file.

## Theme

- Theme color: `#8c1428` (defensive / burgundy accent)
- Background: warm paper `#f7f4ef`

## Version

Current app version: **1.11** (service worker cache `ans-orientation-v11`).
