import './style.css';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let handLandmarker;
let webcamRunning = false;
let lastVideoTime = -1;
let isPinching = false;
let isRightClicking = false;
let leftClickFrames = 0;        // consecutive frames thumb+index are close
let rightClickFrames = 0;       // consecutive frames thumb+middle are close
const CLICK_FRAMES_REQ = 5;     // frames to hold before gesture fires

// Emergency stop
let isStopped = false;

// WebSocket bridge to Python server
let ws = null;
let wsReady = false;

function connectWS() {
  ws = new WebSocket('ws://localhost:8765');
  ws.onopen = () => {
    wsReady = true;
    console.log('[WS] Connected to Virtual Mouse server');
    updateHUD();
  };
  ws.onclose = () => {
    wsReady = false;
    console.warn('[WS] Disconnected — retrying in 2s...');
    updateHUD();
    setTimeout(connectWS, 2000);
  };
  ws.onerror = () => {
    wsReady = false;
    updateHUD();
  };
}

function wsSend(obj) {
  if (ws && wsReady) {
    ws.send(JSON.stringify(obj));
  }
}

// ESC key = emergency stop / resume toggle
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    isStopped = !isStopped;
    wsSend({ type: isStopped ? 'stop' : 'resume' });
    updateHUD();
  }
});

// HUD overlay
const hud = document.getElementById('hud');
function updateHUD() {
  if (!hud) return;
  if (isStopped) {
    hud.textContent = '⛔ STOPPED — Press ESC to Resume';
    hud.className = 'hud-stopped';
  } else if (!wsReady) {
    hud.textContent = '⚠️ Server not connected — run server.py';
    hud.className = 'hud-warn';
  } else {
    hud.textContent = '✅ Virtual Mouse Active — ESC to Stop';
    hud.className = 'hud-active';
  }
}

connectWS();

// ── Spotify gesture state ──────────────────────────────────────────
const SPOTIFY_FRAMES_REQ = 8;   // hold N frames to fire
const SPOTIFY_COOLDOWN = 45;    // frames to wait after firing
let spotifyFrames = { 2: 0, 3: 0, 4: 0 };
let spotifyCooldown = 0;
let spotifyLabel = '';           // shown on canvas after firing
let spotifyLabelFrames = 0;     // how long to show the label

const SPOTIFY_GESTURES = {
  2: { action: 'play_pause', label: '⏯  Play / Pause' },
  3: { action: 'next',       label: '⏭  Next Track'   },
  4: { action: 'prev',       label: '⏮  Prev Track'   },
};

// ── Left hand rotation (volume) ────────────────────────────────────
const WRIST_HIST_LEN = 20;       // sliding window size
const ROT_PER_TICK  = 1.2;       // ~70° accumulated rotation to fire one tick
const VOL_COOLDOWN_F = 25;       // frames between volume ticks
let wristHistory = [];            // recent wrist positions {x, y}
let rotAccum = 0;                 // accumulated signed rotation (radians)
let volCooldown = 0;

function countExtendedFingers(lm) {
  // Compare fingertip y to PIP joint y (lower y = higher on screen = extended)
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  return tips.reduce((n, tip, i) => n + (lm[tip].y < lm[pips[i]].y ? 1 : 0), 0);
}

// Physics variables
const cursor = {
  pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  vel: { x: 0, y: 0 },
};

const target = {
  pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  active: false,
};

// Physics constants
const SPRING_CONSTANT = 0.15; // spring strength
const DAMPING = 0.75; // friction / damping

// Coordinate remapping margins (0.0 - 0.5)
// Increase these if you still can't reach the edges
const MARGIN_X = 0.12; // trim 12% from each side horizontally
const MARGIN_Y = 0.12; // trim 12% from each side vertically

// Remap a value from [margin, 1-margin] to [0, 1], clamped
function remap(value, margin) {
  return Math.max(0, Math.min(1, (value - margin) / (1 - margin * 2)));
}

// Trail history
const maxTrailLen = 20;
let trail = [];

// Initialize MediaPipe
async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numHands: 2  // detect both so we can filter by handedness
  });
  
  startCamera();
}

function startCamera() {
  navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", () => {
      webcamRunning = true;
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);
      requestAnimationFrame(predictWebcam);
    });
  });
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

async function predictWebcam() {
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    
    let startTimeMs = performance.now();
    const results = handLandmarker.detectForVideo(video, startTimeMs);
    
    if (results.landmarks && results.landmarks.length > 0) {
      // Resolve each hand by label (mirrored webcam: user's right = "Left", user's left = "Right")
      let rightHandIdx = -1; // user's right hand — cursor control
      let leftHandIdx  = -1; // user's left hand  — Spotify control
      if (results.handedness) {
        for (let i = 0; i < results.handedness.length; i++) {
          const label = results.handedness[i][0].categoryName;
          if (label === 'Left'  && rightHandIdx === -1) rightHandIdx = i;
          if (label === 'Right' && leftHandIdx  === -1) leftHandIdx  = i;
        }
      }

      // ── RIGHT HAND: cursor + clicks ──────────────────────────────────
      const landmarks = rightHandIdx !== -1 ? results.landmarks[rightHandIdx] : null;

      if (landmarks) {
        const indexFingerTip  = landmarks[8];
        const thumbTip        = landmarks[4];
        const middleFingerTip = landmarks[12];

        // Left click: thumb + index pinch — debounced
        const distLeft = Math.hypot(
          indexFingerTip.x - thumbTip.x,
          indexFingerTip.y - thumbTip.y
        );
        if (distLeft < 0.05) { leftClickFrames++; } else { leftClickFrames = 0; }
        const wasPinching = isPinching;
        isPinching = leftClickFrames >= CLICK_FRAMES_REQ;

        // Right click: thumb + middle finger pinch — debounced
        const distRight = Math.hypot(
          middleFingerTip.x - thumbTip.x,
          middleFingerTip.y - thumbTip.y
        );
        if (distRight < 0.04) { rightClickFrames++; } else { rightClickFrames = 0; }
        const wasRightClicking = isRightClicking;
        isRightClicking = rightClickFrames >= CLICK_FRAMES_REQ && !isPinching;

        // Fire clicks on leading edge
        if (!isStopped) {
          if (isRightClicking && !wasRightClicking) {
            wsSend({ type: 'left_click' });
          } else if (isPinching && !wasPinching && !isRightClicking) {
            wsSend({ type: 'right_click' });
          }
        }

        // Cursor follows index finger tip (mirrored X, remapped)
        const normX  = remap(1 - indexFingerTip.x, MARGIN_X);
        const normY  = remap(indexFingerTip.y, MARGIN_Y);
        target.pos.x = normX * canvas.width;
        target.pos.y = normY * canvas.height;
        target.active = true;

        if (!isStopped) wsSend({ type: 'move', x: normX, y: normY });
      } else {
        // Right hand not visible
        target.active = false;
        isPinching = false;
        isRightClicking = false;
        leftClickFrames = 0;
        rightClickFrames = 0;
      }

      // ── LEFT HAND: Spotify gestures ───────────────────────────────────
      const leftLandmarks = leftHandIdx !== -1 ? results.landmarks[leftHandIdx] : null;

      if (leftLandmarks) {
        const extFingers = countExtendedFingers(leftLandmarks);
        if (spotifyCooldown > 0) {
          spotifyCooldown--;
          for (const k of [2, 3, 4]) spotifyFrames[k] = 0;
        } else {
          for (const [n, g] of Object.entries(SPOTIFY_GESTURES)) {
            const count = parseInt(n);
            if (extFingers === count) {
              spotifyFrames[count]++;
              if (spotifyFrames[count] === SPOTIFY_FRAMES_REQ && !isStopped) {
                wsSend({ type: 'spotify', action: g.action });
                spotifyLabel = g.label;
                spotifyLabelFrames = 90;
                spotifyCooldown = SPOTIFY_COOLDOWN;
                for (const k of [2, 3, 4]) spotifyFrames[k] = 0;
                rotAccum = 0; wristHistory = []; // clear rotation state too
              }
            } else {
              spotifyFrames[count] = 0;
            }
          }
        }

        // ── Rotation detection: wrist circular motion = volume ──────────
        const wrist = leftLandmarks[0];
        wristHistory.push({ x: wrist.x, y: wrist.y });
        if (wristHistory.length > WRIST_HIST_LEN) wristHistory.shift();

        if (volCooldown > 0) {
          volCooldown--;
        } else if (wristHistory.length >= 4) {
          // Centroid of sliding window
          const cx = wristHistory.reduce((s, p) => s + p.x, 0) / wristHistory.length;
          const cy = wristHistory.reduce((s, p) => s + p.y, 0) / wristHistory.length;

          // Signed angle between last two vectors from centroid
          const prev = wristHistory[wristHistory.length - 2];
          const curr = wristHistory[wristHistory.length - 1];
          const ax = prev.x - cx, ay = prev.y - cy;
          const bx = curr.x - cx, by = curr.y - cy;
          const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by);

          if (lenA > 0.005 && lenB > 0.005) {
            // Positive cross = clockwise in screen coords (Y-axis down)
            rotAccum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
          }
          rotAccum *= 0.97; // gentle decay to avoid drift

          if (!isStopped) {
            if (rotAccum > ROT_PER_TICK) {
              wsSend({ type: 'spotify', action: 'vol_up' });
              spotifyLabel = '🔊  Volume Up';
              spotifyLabelFrames = 60;
              rotAccum = 0; wristHistory = []; volCooldown = VOL_COOLDOWN_F;
            } else if (rotAccum < -ROT_PER_TICK) {
              wsSend({ type: 'spotify', action: 'vol_down' });
              spotifyLabel = '🔉  Volume Down';
              spotifyLabelFrames = 60;
              rotAccum = 0; wristHistory = []; volCooldown = VOL_COOLDOWN_F;
            }
          }
        }

      } else {
        // Left hand not visible — reset Spotify + rotation state
        for (const k of [2, 3, 4]) spotifyFrames[k] = 0;
        wristHistory = [];
        rotAccum = 0;
      }

    } else {
      // No hands detected
      target.active = false;
      isPinching = false;
      isRightClicking = false;
      leftClickFrames = 0;
      rightClickFrames = 0;
      for (const k of [2, 3, 4]) spotifyFrames[k] = 0;
      wristHistory = [];
      rotAccum = 0;
    }
  }
  
  updatePhysics();
  drawScene();
  
  if (webcamRunning) {
    requestAnimationFrame(predictWebcam);
  }
}

function simulateClick(x, y) {
  // Legacy DOM click (fallback when server not connected)
  const element = document.elementFromPoint(x, y);
  if (element) {
    element.dispatchEvent(new MouseEvent('mousedown', { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup',   { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    element.dispatchEvent(new MouseEvent('click',     { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  }
}

function simulateRightClick(x, y) {
  // Legacy DOM right-click (fallback when server not connected)
  const element = document.elementFromPoint(x, y);
  if (element) {
    element.dispatchEvent(new MouseEvent('mousedown',  { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    element.dispatchEvent(new MouseEvent('mouseup',    { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    element.dispatchEvent(new MouseEvent('contextmenu',{ view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  }
}

function updatePhysics() {
  if (target.active) {
    const forceX = (target.pos.x - cursor.pos.x) * SPRING_CONSTANT;
    const forceY = (target.pos.y - cursor.pos.y) * SPRING_CONSTANT;
    
    cursor.vel.x += forceX;
    cursor.vel.y += forceY;
  }
  
  cursor.vel.x *= DAMPING;
  cursor.vel.y *= DAMPING;
  
  cursor.pos.x += cursor.vel.x;
  cursor.pos.y += cursor.vel.y;
}

function drawScene() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // When stopped, draw a red vignette overlay
  if (isStopped) {
    const grad = ctx.createRadialGradient(
      canvas.width/2, canvas.height/2, canvas.height * 0.3,
      canvas.width/2, canvas.height/2, canvas.height * 0.85
    );
    grad.addColorStop(0, 'rgba(255,0,0,0)');
    grad.addColorStop(1, 'rgba(255,0,0,0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Save current position to trail
  trail.push({ x: cursor.pos.x, y: cursor.pos.y });
  if (trail.length > maxTrailLen) trail.shift();
  
  // Neon Color Selection
  let neonColor = "rgba(0, 255, 100, 1)";
  if (isRightClicking) {
    neonColor = "rgba(100, 150, 255, 1)"; // Blue for right click
  } else if (isPinching) {
    neonColor = "rgba(255, 60, 100, 1)"; // Red for left click
  }
  
  // Draw trail
  if (trail.length > 1) {
    ctx.beginPath();
    ctx.moveTo(trail[0].x, trail[0].y);
    for (let i = 1; i < trail.length; i++) {
        // Curve through points for a smoother look
        ctx.lineTo(trail[i].x, trail[i].y);
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = neonColor;
    ctx.lineWidth = 12;
    // Glow effect
    ctx.shadowBlur = 30;
    ctx.shadowColor = neonColor;
    ctx.stroke();
  }
  
  // Draw cursor head
  ctx.beginPath();
  ctx.arc(cursor.pos.x, cursor.pos.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "white";
  ctx.shadowBlur = 40;
  ctx.shadowColor = neonColor;
  ctx.fill();

  // Draw an outer ring for the cursor
  ctx.beginPath();
  ctx.arc(cursor.pos.x, cursor.pos.y, 18, 0, Math.PI * 2);
  ctx.strokeStyle = neonColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // ── Spotify gesture progress arc ──────────────────────────────────
  const extFingers = [2, 3, 4].find(n => spotifyFrames[n] > 0);
  if (extFingers && spotifyCooldown === 0) {
    const progress = spotifyFrames[extFingers] / SPOTIFY_FRAMES_REQ;
    const arcColor = extFingers === 2 ? '#1db954'
                   : extFingers === 3 ? '#ff9700'
                   : '#a855f7';

    // Background ring
    ctx.beginPath();
    ctx.arc(cursor.pos.x, cursor.pos.y, 30, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Progress arc
    ctx.beginPath();
    ctx.arc(cursor.pos.x, cursor.pos.y, 30,
      -Math.PI / 2,
      -Math.PI / 2 + progress * Math.PI * 2
    );
    ctx.strokeStyle = arcColor;
    ctx.lineWidth = 4;
    ctx.shadowBlur = 20;
    ctx.shadowColor = arcColor;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Gesture hint label beneath cursor
    const hint = SPOTIFY_GESTURES[extFingers]?.label || '';
    ctx.font = 'bold 15px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = arcColor;
    ctx.shadowBlur = 10;
    ctx.shadowColor = arcColor;
    ctx.fillText(hint, cursor.pos.x, cursor.pos.y + 52);
    ctx.shadowBlur = 0;
  }

  // ── Spotify action flash label ─────────────────────────────────────
  if (spotifyLabelFrames > 0) {
    spotifyLabelFrames--;
    const alpha = Math.min(1, spotifyLabelFrames / 20); // fade out last 20 frames
    ctx.font = 'bold 28px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(29, 185, 84, ${alpha})`;
    ctx.shadowBlur = 30;
    ctx.shadowColor = `rgba(29, 185, 84, ${alpha})`;
    ctx.fillText(spotifyLabel, canvas.width / 2, canvas.height / 2 - 20);
    ctx.shadowBlur = 0;
  }

  // Reset shadow
  ctx.shadowBlur = 0;
}

initMediaPipe();
