# ANS Orientation Tracker

A polished single-page Progressive Web App for **Cal Harris Jr.** to track daily Autonomic Nervous System (ANS) orientation on a −3…+3 grid.

- **X axis:** left = inner functions (−), right = outer actions (+)
- **Y axis:** top = sense of safety (+), bottom = sense of threat (−), center = neutral
- **Optimal Zone (yellow, y > 0):** Nourished · Connected · Energized
- **Defensive Zone (red, y < 0):** Drained · Stuck · Agitated

Markers are numbered per calendar day, stored in `localStorage`, and work offline after the first visit.

## Files

```
ans-orientation-pwa/
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
2. **Long-press an empty spot** on the grid → enter an optional note → **Save marker**.
3. **Tap an existing marker** (or a row in “Markers today”) → view note & timestamp → **Edit** or **Delete**.
4. **Export** downloads a JSON backup; **Import** merges days from a previously exported file.

Timestamps are stored as ISO-8601 UTC and shown in **America/Los_Angeles** (PT).

## Data

- Storage key: `ans-orientation-tracker:v1` in the browser’s `localStorage`
- Nothing is uploaded; data stays on the device
- Clearing site data / uninstalling may wipe markers — use **Export** for backups

## Theme

- Theme color: `#8c1428` (defensive / burgundy accent)
- Background: warm paper `#f7f4ef`
