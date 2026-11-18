# 🛡️ Claude Permission Watcher

A desktop character popup (**tutut**) for **Claude Web (claude.ai)** that alerts you when Claude needs permission to use a tool — even when you're in another app.

## How It Works

```
claude.ai (permission dialog appears)
       │
       ▼
Chrome Extension (detects via MutationObserver)
       │
       ▼
Native Messaging Host (Python bridge)
       │
       ▼
tutut island (drops from the top-centre, always on top, never steals focus)
       │
  [Deny] [Always allow] [Allow once]  ← you click
       │
       ▼
Chrome Extension (clicks the button on claude.ai)
       │
       ▼
Claude continues
```

## Project Structure

```
claude-permission-watcher/
├── extension/               ← Chrome Extension
│   ├── manifest.json        ← Extension config
│   ├── content.js           ← DOM watcher (MutationObserver)
│   ├── background.js        ← Message bridge to the desktop host
│   ├── icon16.png / icon48.png ← Extension icons
│   └── icon128.png          ← Extension icon (large)
│
├── native-host/             ← Desktop Popup App
│   ├── host.py              ← Native messaging host + tutut island (GTK/WebKit)
│   ├── ui/                  ← island.html/css/js
│   │   └── character/       ← tutut: default.svg, character.css, your tutut.png
│   └── com.claude.permission_watcher.json  ← Native messaging manifest
│
├── setup.sh                 ← One-command setup script
└── README.md                ← You are here
```

## Setup

### Prerequisites
- Python 3.8+ with GTK3 + WebKit2 (`sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1`, already on Ubuntu desktop)
- Google Chrome or Chromium
- A claude.ai account with connectors

### Step 1: Clone / Download
```bash
git clone <this-repo>
cd claude-permission-watcher
```

### Step 2: Load the Chrome Extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Note the **Extension ID** shown under the extension name

### Step 3: Run Setup
```bash
chmod +x setup.sh
./setup.sh
```
It will ask for the extension ID from Step 2 (or pass it directly: `./setup.sh <extension-id>`).

Run it as the **same OS user that runs Chrome** — the native host manifest is installed into that user's `~/.config/google-chrome`.
Afterwards, click ↻ on the extension in `chrome://extensions` so it reconnects to the native host.

### Step 4: Enable "Always Ask" on claude.ai
1. Go to [claude.ai](https://claude.ai)
2. Settings → Connectors
3. For any connector, enable **"Always ask before using"**

### Step 5: Test It!
Chat with Claude and trigger a tool call. tutut drops down from the top-centre of your screen.

There are **no Chrome notifications**: if the desktop host isn't installed or running, only the red badge on the extension icon shows (the service worker console logs a warning).

## Preview the island / design tutut

```bash
./native-host/host.py --demo
```
Shows three sample requests (permission, needs-input, permission) without Chrome.
To use your own character, drop `tutut.png` into `native-host/ui/character/`; see [its README](native-host/ui/character/README.md).

## Testing Without Claude

Open DevTools console on claude.ai and paste:

```javascript
// Simulate a permission dialog
const div = document.createElement('div');
div.innerHTML = `
  <div style="padding:16px;background:#2a2a3e;border-radius:8px;margin:8px">
    <p>Claude wants to use Google Drive</p>
    <button style="margin:4px">Allow</button>
    <button style="margin:4px">Deny</button>
  </div>`;
document.querySelector('main')?.appendChild(div) || document.body.appendChild(div);
```

## Phases

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Detect permission prompts + "Needs your input" on claude.ai | ✅ Built |
| 2 | tutut island (always on top, character animations) | ✅ Built |
| 3 | Allow once / Always / Deny from the island → clicks button on page | ✅ Built |
| 4 | Auto-allow/deny rules (whitelist/blacklist) | 🔜 Planned |
| 5 | Audit log of all decisions | 🔜 Planned |

## Platforms

| Platform | Desktop Popup | Chrome Extension |
|----------|--------------|-----------------|
| Linux    | ✅ tutut island (GTK/WebKit, via XWayland on GNOME) | ✅ Chrome |
| macOS / Windows | ⚠️ Tkinter fallback popup | ✅ Chrome |

## How Detection Works

The content script uses two strategies to find permission dialogs:

1. **Text matching** — Scans new DOM nodes for keywords like "wants to use", "allow", "permission"
2. **Button pair detection** — Finds Allow + Deny button pairs appearing together

Both strategies run on a `MutationObserver` (real-time) and a fallback poll (every 2 seconds).

## License

MIT
