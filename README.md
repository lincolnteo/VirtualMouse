# 🖱️ Virtual Mouse

A hand-tracking virtual mouse that runs entirely in your browser. Control your Windows cursor, click, and manage Spotify — all with hand gestures captured by your webcam. No external hardware required.

Built with **MediaPipe Hands**, **Vite**, and a lightweight **Python WebSocket bridge**.

---

## 📋 Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running the App](#running-the-app)
- [Gestures Reference](#gestures-reference)
  - [Right Hand — Cursor Control](#right-hand--cursor-control)
  - [Left Hand — Spotify Control](#left-hand--spotify-control)
- [HUD Status Indicator](#hud-status-indicator)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)

---

## How It Works

```
Webcam → Browser (MediaPipe) → WebSocket → Python Server → Windows OS
```

1. Your **webcam** captures your hand in real time.
2. **MediaPipe Hands** (running in-browser via WebAssembly/GPU) detects hand landmarks at high speed.
3. The browser sends compact JSON commands over a **WebSocket** to `server.py`.
4. The Python server translates those commands into real **OS-level actions** — moving the cursor, clicking, and controlling Spotify — using `pyautogui` and `pycaw`.

---

## Prerequisites

Make sure you have the following installed before starting:

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | v18+ | For the Vite dev server |
| **Python** | 3.10+ | For the WebSocket bridge |
| **pip** | Latest | Python package manager |
| **Webcam** | Any | Built-in or USB |
| **Windows** | 10 / 11 | Required — uses Windows-only audio APIs |
| **Spotify** | Desktop app | Must be open for volume control |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/VirtualMouse.git
cd VirtualMouse
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Set up the Python virtual environment

```bash
python -m venv .venv
```

### 4. Install Python dependencies

```bash
.venv\Scripts\pip install pyautogui websockets pycaw
```

> **Why these packages?**
> - `pyautogui` — moves the mouse and sends key presses
> - `websockets` — async WebSocket server
> - `pycaw` — Windows Core Audio API wrapper (Spotify-only volume control)

---

## Running the App

You need **two terminals** running simultaneously.

### Terminal 1 — Start the Vite frontend

```bash
npm run dev
```

This starts the frontend at `http://localhost:5173`. Open that URL in your browser.

### Terminal 2 — Start the Python WebSocket server

```bash
.venv\Scripts\python.exe server.py
```

You should see:

```
==================================================
  Virtual Mouse Server
==================================================
  Screen resolution : 2560 x 1600
  Listening on      : ws://localhost:8765
  Emergency stop    : Press ESC in the browser
  Quit server       : Ctrl+C here
==================================================
```

Once both are running:
1. Open **`http://localhost:5173`** in your browser
2. Allow **camera access** when prompted
3. The HUD at the top will turn green: `✅ Virtual Mouse Active — ESC to Stop`
4. Hold your hand in front of the webcam and start gesturing!

---

## Gestures Reference

> **Important:** The webcam image is mirrored (like a mirror), so MediaPipe's "Left" hand label corresponds to your **right hand**, and vice versa. The app accounts for this automatically.

---

### Right Hand — Cursor Control

Your **right hand** controls the mouse cursor and clicks.

| Gesture | Action | Visual Feedback |
|---|---|---|
| ☝️ **Index finger pointed up** | Move cursor | Neon green trail follows your finger |
| 👌 **Thumb + Index pinch** | **Left click** | Cursor trail turns **red** |
| 🤏 **Thumb + Middle finger pinch** | **Right click** | Cursor trail turns **blue** |

#### Tips for smooth cursor movement:
- Keep your **index finger extended** and other fingers curled for the most precise tracking.
- The cursor uses a **spring-physics model** — it smoothly catches up to your finger rather than snapping instantly. This reduces jitter.
- The tracking zone has a **12% margin on each edge** cropped out, so you can comfortably reach all screen corners without needing to move your hand to the very edge of frame.
- **Clicks are debounced** — you must hold the pinch for ~5 frames before it fires, preventing accidental clicks.

---

### Left Hand — Spotify Control

Your **left hand** is dedicated to Spotify controls. The number of **extended fingers** (index to pinky, thumb excluded) determines the action.

#### Finger Gestures (hold for ~8 frames to trigger)

| Fingers Extended | Gesture | Action |
|---|---|---|
| ✌️ **2 fingers** (index + middle) | Peace sign | ⏯ **Play / Pause** |
| 🤟 **3 fingers** (index + middle + ring) | Three-finger salute | ⏭ **Next Track** |
| 🖖 **4 fingers** (index to pinky) | Four fingers | ⏮ **Previous Track** |

A **progress arc** animates around the cursor as you hold the gesture, confirming it's being detected. The action fires when the arc completes.

#### Wrist Rotation — Volume Control

Rotate your **left wrist in a circular motion** to control Spotify's volume:

| Motion | Action |
|---|---|
| 🔁 **Clockwise rotation** | 🔊 Volume Up (+5%) |
| 🔄 **Counter-clockwise rotation** | 🔉 Volume Down (-5%) |

> **Note:** This adjusts **only Spotify's app volume**, not your system volume. Spotify must be open and actively playing (or have played audio recently) for this to work. The server will log `[Spotify] Spotify not found` if it can't find Spotify's audio session.

#### Cooldowns (prevent accidental double-fires)
- **Finger gestures**: 45-frame cooldown after firing
- **Volume ticks**: 25-frame cooldown between each tick

---

### Emergency Stop

Press **`ESC`** in the browser at any time to toggle the mouse control on/off.

| State | HUD Display | Effect |
|---|---|---|
| 🟢 Active | `✅ Virtual Mouse Active — ESC to Stop` | Full control enabled |
| 🔴 Stopped | `⛔ STOPPED — Press ESC to Resume` | Red vignette overlay; all mouse+Spotify commands blocked |

---

## HUD Status Indicator

The status bar at the top of the screen shows the current connection state:

| Color | Message | Meaning |
|---|---|---|
| 🟡 Yellow | `⚠️ Server not connected — run server.py` | Python server isn't running |
| 🟢 Green | `✅ Virtual Mouse Active — ESC to Stop` | Everything working |
| 🔴 Red | `⛔ STOPPED — Press ESC to Resume` | Emergency stop is active |

---

## Project Structure

```
VirtualMouse/
├── index.html          # App entry point (webcam + canvas overlay)
├── package.json        # Node dependencies (Vite, MediaPipe)
├── server.py           # Python WebSocket server (pyautogui + pycaw)
├── src/
│   ├── main.js         # Hand tracking, gesture logic, WebSocket client
│   └── style.css       # Neon UI styles
├── public/             # Static assets
└── .venv/              # Python virtual environment
```

---

## Troubleshooting

### `⚠️ Server not connected` — browser shows yellow HUD
- Make sure `server.py` is running in a separate terminal.
- Check that port **8765** is not blocked by a firewall or in use by another process.
- To free a stuck port: `Stop-Process -Id (Get-NetTCPConnection -LocalPort 8765).OwningProcess -Force`

### Cursor is laggy or jumpy
- Ensure you have good, consistent lighting — MediaPipe struggles in the dark.
- Keep your hand within ~50–80cm of the webcam for best landmark accuracy.
- Close other GPU-heavy applications to free up resources for the WebAssembly model.

### Clicks aren't registering
- The click requires a pinch held for **~5 frames** (~170ms at 30fps) — hold it slightly longer.
- Make sure your thumb and finger actually come close enough together (threshold: 5% of frame width for left click, 4% for right click).

### Spotify volume control not working
- Spotify must be **open** and have **played audio** at least once in this session.
- Make sure you installed `pycaw`: `.venv\Scripts\pip install pycaw`
- The server prints `[Spotify] volume 0.XX → 0.XX` when it works — check the terminal.

### `OSError: [Errno 10048]` — port already in use
- Another `server.py` instance is still running. Kill it with:
  ```powershell
  Stop-Process -Id (Get-NetTCPConnection -LocalPort 8765).OwningProcess -Force
  ```
  Then restart `server.py`.

### Camera permission denied
- Click the camera icon in your browser's address bar and allow access.
- Refresh the page after granting permission.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Hand Tracking | [MediaPipe Hands](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (WebAssembly + GPU) |
| Frontend | Vanilla JS + HTML5 Canvas |
| Build Tool | [Vite](https://vitejs.dev/) |
| WebSocket Server | Python `asyncio` + `websockets` |
| Mouse Control | [`pyautogui`](https://pyautogui.readthedocs.io/) |
| Spotify Volume | [`pycaw`](https://github.com/AndreMiras/pycaw) (Windows Core Audio API) |

---

*Built using MediaPipe + Python*
