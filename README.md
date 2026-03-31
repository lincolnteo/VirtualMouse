# 🌌 Cyber-Link: Neural Hand Tracking Demo

A high-end, standalone browser tech-demo that uses **MediaPipe Hands** to create a futuristic "Neural Interface." Control an on-screen neon cursor and interact with terminal UI elements using nothing but your hands in front of the webcam.

---

## 🚀 Experience the Demo

This is a **standalone browser application**. No background servers or local drivers are required to run the primary tracking and interaction engine.

### 1. Installation
Ensure you have [Node.js](https://nodejs.org/) installed, then:
```bash
# Install dependencies (Vite, MediaPipe)
npm install

# Start the dev server
npm run dev
```

### 2. Interaction Guide
Open the provided local URL (usually `http://localhost:5173`) and allow camera access.

| Action | Gesture |
| :--- | :--- |
| **Move Cursor** | Point your **Index Finger** at the screen. |
| **Selection (Click)** | **Pinch** your Index Finger and Thumb together. |
| **Access Node** | **Pinch** your Middle Finger and Thumb together. |
| **Vertical Scroll** | Touch **Index and Middle** fingers and move up/down. |
| **Adjust Gain** | Swipe your **Open Palm** up or down rapidly. |
| **Emergency Stop** | Press **ESC** on your keyboard to pause tracking. |

---

## 🛠️ Tech Stack
*   **Engine**: MediaPipe Hands (Tasks Vision)
*   **Frontend**: Vite, Vanilla JS, HTML5 Canvas
*   **Styling**: High-end CSS with Glassmorphism, Scan-line filters, and Neon effects.
*   **Physics**: Custom Spring-Damping model for "weighty" cursor movement.

---

## 🎨 Portfolio Highlights
*   **Standalone NUI**: Demonstrates complex 3D-to-2D hand landmark remapping without a backend bridge.
*   **Interactive Terminal**: Features a reactive sci-fi UI that responds to virtual hover and click events using `elementFromPoint` detection.
*   **Visual Juice**: Includes a high-performance particle engine and dynamic "sonic ripple" feedback system.

---

*Developed for Portfolio Showcase by Antigravity*
