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
const CLICK_FRAMES_REQ = 4;

let prevScrollY = null, isScrolling = false;
const SCROLL_THRESHOLD = 0.004;

const SWIPE_WIN = 8, SWIPE_THRESH = 0.05;
let wristYHistory = [], volCooldown = 0;

// --- VISUAL EFFECTS STATE ---
let currentHandLandmarks = null;
const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[11,12],[13,14],[15,16],[17,18],[19,20],[0,5],[0,17],[5,9],[9,13],[13,17]];

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
  update() { this.radius += 6; this.life -= this.decay; }
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

// --- INTERACTIVE STANDALONE LOGIC ---
function simulateClick(x, y) {
  const element = document.elementFromPoint(x, y);
  if (element && (element.classList.contains('ui-button') || element.classList.contains('data-node'))) {
    element.classList.add('active');
    setTimeout(() => element.classList.remove('active'), 200);
    
    // Custom logic for the demo elements
    if (element.id.startsWith('btn')) {
      statusLabel = `EXECUTED: ${element.textContent}`;
      statusLabelFrames = 60;
    } else if (element.id.startsWith('node')) {
      statusLabel = "NODE ACCESSED";
      statusLabelFrames = 50;
    }
    
    // Also trigger actual DOM events for portfolio breadth
    element.click();
  }
}

let lastHoveredElement = null;
function handleHover(x, y) {
  const element = document.elementFromPoint(x, y);
  if (element !== lastHoveredElement) {
    if (lastHoveredElement) lastHoveredElement.classList.remove('hover');
    if (element && (element.classList.contains('ui-button') || element.classList.contains('data-node'))) {
      element.classList.add('hover');
      lastHoveredElement = element;
    } else {
      lastHoveredElement = null;
    }
  }
}

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { 
    isStopped = !isStopped;
    const hud = document.getElementById('hud');
    if (isStopped) {
      hud.textContent = '⛔ NEURAL OVERRIDE PAUSED';
      hud.className = 'hud-stopped';
    } else {
      hud.textContent = '✅ STANDALONE DEMO ACTIVE';
      hud.className = 'hud-active';
    }
  }
});

// --- PHYSICS ---
const cursor = { pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }, vel: { x: 0, y: 0 } };
const target = { pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }, active: false };
const SPRING_CONSTANT = 0.14, DAMPING = 0.78, MARGIN_X = 0.1, MARGIN_Y = 0.1;

function remap(value, margin) { return Math.max(0, Math.min(1, (value - margin) / (1 - margin * 2))); }
function countExtendedFingers(lm) { return [8, 12, 16, 20].reduce((n, tip, i) => n + (lm[tip].y < lm[[6, 10, 14, 18][i]].y ? 1 : 0), 0); }

async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
  handLandmarker = await HandLandmarker.createFromOptions(vision, { 
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: "GPU" }, 
    runningMode: "VIDEO", numHands: 1 
  });
  startCamera();
}

function startCamera() {
  navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", () => { webcamRunning = true; resizeCanvas(); window.requestAnimationFrame(predictWebcam); });
  });
}

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', resizeCanvas);

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
        if (isRightClicking && !wasR) { 
          ripples.push(new Ripple(cursor.pos.x, cursor.pos.y, "rgba(0, 150, 255, 1)")); 
          simulateClick(cursor.pos.x, cursor.pos.y);
        } else if (isPinching && !wasP && !isRightClicking) { 
          ripples.push(new Ripple(cursor.pos.x, cursor.pos.y, "rgba(255, 50, 80, 1)")); 
          simulateClick(cursor.pos.x, cursor.pos.y);
        }
      }

      // SCROLL/GESTURE TRACKING
      const dS = Math.hypot(indexTip.x - middleTip.x, indexTip.y - middleTip.y);
      const ext = countExtendedFingers(landmarks);
      if (dS < 0.032 && ext >= 2) { 
        if (prevScrollY !== null) { 
          let dy = indexTip.y - prevScrollY; 
          if (Math.abs(dy) > SCROLL_THRESHOLD) { 
            window.scrollBy(0, dy * 2000); // Standalone scroll
            isScrolling = true; 
          } 
        } 
        prevScrollY = indexTip.y; 
      } else { prevScrollY = null; isScrolling = false; }

      // VOL / SWIPE
      if (ext >= 4 && !isScrolling) {
        wristYHistory.push(wrist.y); if (wristYHistory.length > SWIPE_WIN) wristYHistory.shift();
        if (volCooldown > 0) volCooldown--;
        else if (wristYHistory.length === SWIPE_WIN) {
          let ny = wristYHistory[SWIPE_WIN - 1] - wristYHistory[0];
          if (Math.abs(ny) > SWIPE_THRESH && !isStopped) { 
            let act = ny < 0 ? 'up' : 'down'; 
            statusLabel = act === 'up' ? '🔊 GAIN UP' : '🔉 GAIN DOWN'; statusLabelFrames = 40; 
            volCooldown = 20; wristYHistory = []; 
          }
        }
      } else { wristYHistory = []; }

      // MOVE
      const nX = remap(1 - indexTip.x, MARGIN_X), nY = remap(indexTip.y, MARGIN_Y);
      target.pos.x = nX * canvas.width; target.pos.y = nY * canvas.height; target.active = true;
      handleHover(target.pos.x, target.pos.y);
    } else { currentHandLandmarks = null; target.active = false; isPinching = isRightClicking = isScrolling = false; wristYHistory = []; }
  }
  updatePhysics(); drawScene(); if (webcamRunning) window.requestAnimationFrame(predictWebcam);
}

function updatePhysics() { if (target.active) { cursor.vel.x += (target.pos.x - cursor.pos.x) * SPRING_CONSTANT; cursor.vel.y += (target.pos.y - cursor.pos.y) * SPRING_CONSTANT; } cursor.vel.x *= DAMPING; cursor.vel.y *= DAMPING; cursor.pos.x += cursor.vel.x; cursor.pos.y += cursor.vel.y; }

function drawScene() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (isStopped) { ctx.fillStyle = "rgba(255, 0, 0, 0.05)"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  if (currentHandLandmarks) { drawHandSkeleton(currentHandLandmarks); }

  let color = "rgba(0, 255, 150, 1)";
  if (isRightClicking) color = "rgba(0, 150, 255, 1)";
  else if (isPinching) color = "rgba(255, 50, 80, 1)";
  else if (isScrolling) color = "rgba(255, 200, 0, 1)";
  
  if (target.active) { for(let i=0; i<2; i++) particles.push(new Particle(cursor.pos.x, cursor.pos.y, color)); }
  particles = particles.filter(p => { p.update(); if (p.life > 0) p.draw(ctx); return p.life > 0; });
  ripples = ripples.filter(r => { r.update(); if (r.life > 0) r.draw(ctx); return r.life > 0; });

  ctx.beginPath(); ctx.arc(cursor.pos.x, cursor.pos.y, 6, 0, Math.PI * 2); ctx.fillStyle = "white"; ctx.shadowBlur = 30; ctx.shadowColor = color; ctx.fill();
  ctx.beginPath(); ctx.arc(cursor.pos.x, cursor.pos.y, 14, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();

  if (statusLabelFrames > 0) {
    statusLabelFrames--; let a = Math.min(1, statusLabelFrames / 15);
    ctx.font = 'bold 22px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(255, 255, 255, ${a})`; ctx.shadowBlur = 20; ctx.shadowColor = color; ctx.fillText(statusLabel, canvas.width/2, canvas.height/2 + 180);
  }
}

function drawHandSkeleton(lms) {
  ctx.beginPath(); ctx.strokeStyle = "rgba(0, 255, 150, 0.2)"; ctx.lineWidth = 1; ctx.shadowBlur = 5; ctx.shadowColor = "rgba(0, 255, 150, 0.25)";
  [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[0,5],[0,17],[5,9],[9,13],[13,17]].forEach(([s, e]) => { 
    ctx.moveTo((1-lms[s].x)*canvas.width, lms[s].y*canvas.height); ctx.lineTo((1-lms[e].x)*canvas.width, lms[e].y*canvas.height); 
  });
  ctx.stroke();
  lms.forEach((p, i) => { if (i===8||i===12||i===4) { ctx.beginPath(); ctx.arc((1-p.x)*canvas.width, p.y*canvas.height, 2, 0, Math.PI*2); ctx.fillStyle = "#00ff99"; ctx.fill(); } });
}
initMediaPipe();
