import './style.css';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let handLandmarker;
let webcamRunning = false;
let lastVideoTime = -1;

// --- GESTURE STATE ---
let isPinching = false, isRightClicking = false;
let leftClickFrames = 0, rightClickFrames = 0;
const CLICK_FRAMES_REQ = 4; // Snappier click

let prevScrollY = null, isScrolling = false;
const SCROLL_THRESHOLD = 0.004;

const SWIPE_WIN = 8, SWIPE_THRESH = 0.05;
let wristYHistory = [], volCooldown = 0;

// --- VISUAL EFFECTS STATE ---
let currentHandLandmarks = null;
const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],[0,5],[0,17]];

let particles = [], ripples = [];
class Particle {
  constructor(x, y, color) {
    this.x = x; this.y = y; this.color = color;
    this.vx = (Math.random() - 0.5) * 2.5;
    this.vy = (Math.random() - 0.5) * 2.5;
    this.size = Math.random() * 2.5 + 1;
    this.life = 1.0; this.decay = Math.random() * 0.03 + 0.02;
  }
  update() { this.x += this.vx; this.y += this.vy; this.life -= this.decay; }
  draw(ctx) {
    if (this.life <= 0) return;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
    ctx.fillStyle = this.color.replace('1)', `${this.life * 0.8})`);
    ctx.fill();
  }
}

class Ripple {
  constructor(x, y, color) { this.x = x; this.y = y; this.color = color; this.radius = 0; this.life = 1.0; this.decay = 0.05; }
  update() { this.radius += 5; this.life -= this.decay; }
  draw(ctx) {
    if (this.life <= 0) return;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.strokeStyle = this.color.replace('1)', `${this.life})`);
    ctx.lineWidth = 4 * this.life;
    ctx.stroke();
  }
}

let statusLabel = '', statusLabelFrames = 0, isStopped = false;

// --- BRIDGE ---
let ws = null, wsReady = false;
function connectWS() {
  ws = new WebSocket('ws://localhost:8765');
  ws.onopen = () => { wsReady = true; updateHUD(); };
  ws.onclose = () => { wsReady = false; updateHUD(); setTimeout(connectWS, 2000); };
}
function wsSend(obj) { if (ws && wsReady) ws.send(JSON.stringify(obj)); }

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { isStopped = !isStopped; wsSend({ type: isStopped ? 'stop' : 'resume' }); updateHUD(); }
});

const hud = document.getElementById('hud');
function updateHUD() {
  if (!hud) return;
  if (isStopped) { hud.textContent = '⛔ SYSTEM PAUSED'; hud.className = 'hud-stopped'; }
  else if (!wsReady) { hud.textContent = '⚠️ BRIDGE OFFLINE'; hud.className = 'hud-warn'; }
  else { hud.textContent = '✅ NEURAL LINK ACTIVE'; hud.className = 'hud-active'; }
}
connectWS();

// --- PHYSICS (Weighty & Fluid) ---
const cursor = { pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }, vel: { x: 0, y: 0 } };
const target = { pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }, active: false };
const SPRING_CONSTANT = 0.12; 
const DAMPING = 0.8; 
const MARGIN_X = 0.12, MARGIN_Y = 0.12;

function remap(value, margin) { return Math.max(0, Math.min(1, (value - margin) / (1 - margin * 2))); }
function countExtendedFingers(lm) { return [8, 12, 16, 20].reduce((n, tip, i) => n + (lm[tip].y < lm[[6, 10, 14, 18][i]].y ? 1 : 0), 0); }

async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
  handLandmarker = await HandLandmarker.createFromOptions(vision, { 
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: "GPU" }, 
    runningMode: "VIDEO", 
    numHands: 1 
  });
  startCamera();
}

function startCamera() {
  navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", () => { webcamRunning = true; resizeCanvas(); window.addEventListener('resize', resizeCanvas); requestAnimationFrame(predictWebcam); });
  });
}

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }

async function predictWebcam() {
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const results = handLandmarker.detectForVideo(video, performance.now());
    
    if (results.landmarks && results.landmarks.length > 0) {
      const landmarks = results.landmarks[0];
      currentHandLandmarks = landmarks;
      const indexTip = landmarks[8], thumbTip = landmarks[4], middleTip = landmarks[12], wrist = landmarks[0];

      // PINCH DETECTION
      const dL = Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y);
      if (dL < 0.05) { leftClickFrames++; } else { leftClickFrames = 0; }
      const wasP = isPinching; isPinching = leftClickFrames >= CLICK_FRAMES_REQ;
      
      const dR = Math.hypot(middleTip.x - thumbTip.x, middleTip.y - thumbTip.y);
      if (dR < 0.04) { rightClickFrames++; } else { rightClickFrames = 0; }
      const wasR = isRightClicking; isRightClicking = rightClickFrames >= CLICK_FRAMES_REQ && !isPinching;

      if (!isStopped) {
        if (isRightClicking && !wasR) { wsSend({ type: 'right_click' }); ripples.push(new Ripple(cursor.pos.x, cursor.pos.y, "rgba(0, 150, 255, 1)")); }
        else if (isPinching && !wasP && !isRightClicking) { wsSend({ type: 'left_click' }); ripples.push(new Ripple(cursor.pos.x, cursor.pos.y, "rgba(255, 50, 80, 1)")); }
      }

      // SCROLL
      const dS = Math.hypot(indexTip.x - middleTip.x, indexTip.y - middleTip.y);
      const ext = countExtendedFingers(landmarks);
      if (dS < 0.032 && ext >= 2) { 
        if (prevScrollY !== null) { 
          let dy = indexTip.y - prevScrollY; 
          if (Math.abs(dy) > SCROLL_THRESHOLD) { 
            wsSend({ type: 'scroll', amount: -dy * 6000 }); 
            isScrolling = true; 
          } 
        } 
        prevScrollY = indexTip.y; 
      } else { prevScrollY = null; isScrolling = false; }

      // VOL
      if (ext >= 4 && !isScrolling) {
        wristYHistory.push(wrist.y); 
        if (wristYHistory.length > SWIPE_WIN) wristYHistory.shift();
        if (volCooldown > 0) volCooldown--;
        else if (wristYHistory.length === SWIPE_WIN) {
          let ny = wristYHistory[SWIPE_WIN - 1] - wristYHistory[0];
          if (Math.abs(ny) > SWIPE_THRESH && !isStopped) { 
            let act = ny < 0 ? 'up' : 'down'; 
            wsSend({ type: 'volume', action: act }); 
            statusLabel = act === 'up' ? '🔊 GAIN UP' : '🔉 GAIN DOWN'; 
            statusLabelFrames = 40; 
            volCooldown = 15; 
            wristYHistory = []; 
          }
        }
      } else { wristYHistory = []; }

      // MOVE
      const nX = remap(1 - indexTip.x, MARGIN_X), nY = remap(indexTip.y, MARGIN_Y);
      target.pos.x = nX * canvas.width; target.pos.y = nY * canvas.height; target.active = true;
      if (!isStopped && !isScrolling) wsSend({ type: 'move', x: nX, y: nY });
    } else { currentHandLandmarks = null; target.active = false; isPinching = isRightClicking = isScrolling = false; wristYHistory = []; }
  }
  updatePhysics(); 
  drawScene(); 
  if (webcamRunning) requestAnimationFrame(predictWebcam);
}

function updatePhysics() { 
  if (target.active) { 
    cursor.vel.x += (target.pos.x - cursor.pos.x) * SPRING_CONSTANT; 
    cursor.vel.y += (target.pos.y - cursor.pos.y) * SPRING_CONSTANT; 
  } 
  cursor.vel.x *= DAMPING; 
  cursor.vel.y *= DAMPING; 
  cursor.pos.x += cursor.vel.x; 
  cursor.pos.y += cursor.vel.y; 
}

function drawScene() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  if (isStopped) { 
    ctx.fillStyle = "rgba(255, 0, 0, 0.05)"; 
    ctx.fillRect(0, 0, canvas.width, canvas.height); 
  }

  // Draw background Hand Skeleton
  if (currentHandLandmarks) { drawHandSkeleton(currentHandLandmarks); }

  let color = "rgba(0, 255, 150, 1)";
  if (isRightClicking) color = "rgba(0, 150, 255, 1)";
  else if (isPinching) color = "rgba(255, 50, 80, 1)";
  else if (isScrolling) color = "rgba(255, 200, 0, 1)";
  
  // Particles & Ripples
  if (target.active) {
    for(let i=0; i<2; i++) particles.push(new Particle(cursor.pos.x, cursor.pos.y, color));
  }
  
  particles = particles.filter(p => { 
    p.update(); 
    if (p.life > 0) p.draw(ctx); 
    return p.life > 0; 
  });
  
  ripples = ripples.filter(r => { 
    r.update(); 
    if (r.life > 0) r.draw(ctx); 
    return r.life > 0; 
  });

  // Cursor core
  ctx.beginPath(); 
  ctx.arc(cursor.pos.x, cursor.pos.y, 6, 0, Math.PI * 2); 
  ctx.fillStyle = "white"; 
  ctx.shadowBlur = 30; 
  ctx.shadowColor = color; 
  ctx.fill();

  // Outer ring
  ctx.beginPath(); 
  ctx.arc(cursor.pos.x, cursor.pos.y, 14, 0, Math.PI * 2); 
  ctx.strokeStyle = color; 
  ctx.lineWidth = 2.5; 
  ctx.stroke();

  // Status Label
  if (statusLabelFrames > 0) {
    statusLabelFrames--; 
    let a = Math.min(1, statusLabelFrames / 15);
    ctx.font = 'bold 22px "JetBrains Mono", monospace'; 
    ctx.textAlign = 'center'; 
    ctx.fillStyle = `rgba(255, 255, 255, ${a})`; 
    ctx.shadowBlur = 20; 
    ctx.shadowColor = color;
    ctx.fillText(statusLabel, canvas.width/2, canvas.height/2 + 150);
  }

  ctx.shadowBlur = 0;
}

function drawHandSkeleton(lms) {
  ctx.beginPath(); 
  ctx.strokeStyle = "rgba(0, 255, 150, 0.2)"; 
  ctx.lineWidth = 1; 
  ctx.shadowBlur = 5; 
  ctx.shadowColor = "rgba(0, 255, 150, 0.25)";
  
  HAND_CONNECTIONS.forEach(([s, e]) => { 
    let p1 = lms[s], p2 = lms[e]; 
    ctx.moveTo((1-p1.x)*canvas.width, p1.y*canvas.height); 
    ctx.lineTo((1-p2.x)*canvas.width, p2.y*canvas.height); 
  });
  ctx.stroke();

  // Minimal joint dots
  lms.forEach((p, i) => { 
    if (i===8||i===12||i===4) { 
      ctx.beginPath(); 
      ctx.arc((1-p.x)*canvas.width, p.y*canvas.height, 2, 0, Math.PI*2); 
      ctx.fillStyle = "#00ff99"; 
      ctx.fill(); 
    } 
  });
}
initMediaPipe();
