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
      // Find the right hand by handedness label
      // Note: front-facing webcams are mirrored, so MediaPipe may label
      // your right hand as "Left". If tracking feels reversed, swap to "Left".
      let handIndex = -1;
      if (results.handedness) {
        for (let i = 0; i < results.handedness.length; i++) {
          if (results.handedness[i][0].categoryName === "Left") {
            handIndex = i;
            break;
          }
        }
      }
      // Fall back to first hand if handedness unavailable
      if (handIndex === -1) handIndex = 0;

      const landmarks = results.landmarks[handIndex];
      if (!landmarks) {
        // Right hand not visible — reset and skip
        target.active = false;
        isPinching = false;
        isRightClicking = false;
        leftClickFrames = 0;
        rightClickFrames = 0;
        updatePhysics();
        drawScene();
        if (webcamRunning) requestAnimationFrame(predictWebcam);
        return;
      }

      const indexFingerTip = landmarks[8];  // Index finger tip
      const thumbTip = landmarks[4];        // Thumb tip
      const middleFingerTip = landmarks[12]; // Middle finger tip

      // Left click: thumb + index pinch — debounced
      const distLeft = Math.hypot(
        indexFingerTip.x - thumbTip.x,
        indexFingerTip.y - thumbTip.y
      );
      if (distLeft < 0.05) {
        leftClickFrames++;
      } else {
        leftClickFrames = 0;
      }
      const wasPinching = isPinching;
      isPinching = leftClickFrames >= CLICK_FRAMES_REQ;

      // Right click: thumb + middle finger pinch — debounced
      const distRight = Math.hypot(
        middleFingerTip.x - thumbTip.x,
        middleFingerTip.y - thumbTip.y
      );
      if (distRight < 0.04) {
        rightClickFrames++;
      } else {
        rightClickFrames = 0;
      }
      const wasRightClicking = isRightClicking;
      isRightClicking = rightClickFrames >= CLICK_FRAMES_REQ && !isPinching;

      // Fire clicks only on the leading edge (gesture start)
      if (!isStopped) {
        if (isRightClicking && !wasRightClicking) {
          wsSend({ type: 'left_click' });
        } else if (isPinching && !wasPinching && !isRightClicking) {
          wsSend({ type: 'right_click' });
        }
      }

      // Cursor always follows the index finger tip (mirrored X)
      // Remap so the hand doesn't need to reach the camera's very edge
      const normX = remap(1 - indexFingerTip.x, MARGIN_X); // mirrored
      const normY = remap(indexFingerTip.y, MARGIN_Y);
      const targetX = normX * canvas.width;
      const targetY = normY * canvas.height;

      target.pos.x = targetX;
      target.pos.y = targetY;
      target.active = true;

      // Send normalized cursor position to Python server
      if (!isStopped) {
        wsSend({ type: 'move', x: normX, y: normY });
      }
    } else {
      target.active = false;
      isPinching = false;
      isRightClicking = false;
      leftClickFrames = 0;
      rightClickFrames = 0;
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
  
  // Reset shadow
  ctx.shadowBlur = 0;
}

initMediaPipe();
