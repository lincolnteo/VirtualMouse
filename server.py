"""
Virtual Mouse Server
====================
Bridges browser hand-tracking → real Windows mouse via pyautogui.

Install dependencies:
    pip install pyautogui websockets

Run:
    python server.py

Then open http://localhost:5173 in your browser.
Press ESC in browser (or Ctrl+C here) to stop.
"""

import asyncio
import json
import sys
import pyautogui
import websockets

# Safety: disable pyautogui's own failsafe (we have ESC in the browser)
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0  # remove default delay between calls for low latency

screen_w, screen_h = pyautogui.size()
connected_clients = set()
paused = False  # tracks emergency-stop state


async def handler(websocket):
    global paused
    connected_clients.add(websocket)
    client_addr = websocket.remote_address
    print(f"[+] Browser connected from {client_addr}")

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
                msg_type = data.get("type")

                if msg_type == "stop":
                    paused = True
                    print("[!] Emergency STOP received — mouse control paused.")

                elif msg_type == "resume":
                    paused = False
                    print("[>] Resumed — mouse control active.")

                elif paused:
                    # Ignore all move/click commands while stopped
                    continue

                elif msg_type == "move":
                    # Normalized 0-1 coords → actual screen pixels
                    x = int(data["x"] * screen_w)
                    y = int(data["y"] * screen_h)
                    pyautogui.moveTo(x, y, _pause=False)

                elif msg_type == "left_click":
                    pyautogui.click(_pause=False)

                elif msg_type == "right_click":
                    pyautogui.rightClick(_pause=False)

                elif msg_type == "scroll":
                    # amount is positive for up, negative for down
                    amount = int(data.get("amount", 0))
                    pyautogui.scroll(amount, _pause=False)

                elif msg_type == "volume":
                    action = data.get("action")
                    if action == "up":
                        pyautogui.press("volumeup")
                    elif action == "down":
                        pyautogui.press("volumedown")

            except (json.JSONDecodeError, KeyError) as e:
                print(f"[!] Bad message: {e}")

    except websockets.exceptions.ConnectionClosedOK:
        pass
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"[!] Connection error: {e}")
    finally:
        connected_clients.discard(websocket)
        print(f"[-] Browser disconnected from {client_addr}")


async def main():
    print("=" * 50)
    print("  Virtual Mouse Server")
    print("=" * 50)
    print(f"  Screen resolution : {screen_w} x {screen_h}")
    print(f"  Listening on      : ws://localhost:8765")
    print(f"  Emergency stop    : Press ESC in the browser")
    print(f"  Quit server       : Ctrl+C here")
    print("=" * 50)

    async with websockets.serve(handler, "localhost", 8765):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[x] Server stopped.")
        sys.exit(0)
