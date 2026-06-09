# 🥊 Stanford Fight Club

https://anni-stanford.github.io/stanford-fight-club/ 

**Stanford Fight Club** makes staying fit genuinely fun. It turns your webcam into a boxing ring — no controller, no gym, no gear. Square up to your screen and fight an AI that *learns your style* or a friend across the internet who reacts to your every move, building fitness, reflexes, and real boxing skills while you play. **Your body is the controller. Step in and throw down.**

> 🎓 **This project was built while working on the CS 153: Frontier Systems at Stanford.** Built solo with heavy AI assistance (see [AI Usage](#-ai-usage-disclosure)).

---

## What it does

Fight Club runs entirely in your browser — **no install, no login, no API keys, completely free**. A webcam + real-time pose estimation reads your movement, a lightweight gesture classifier turns it into boxing moves (**jab, cross, hook, slip, block**), and a game loop reacts to you in real time.

Three modes:

| Mode | What happens |
|------|--------------|
| 🎯 **Training** | The coach calls out moves and grades your timing/accuracy rep by rep. The "boxing tutor" layer. |
| 🤖 **Single Player** | A **4-level campaign vs an AI that learns YOU.** Between every level a small neural network (TensorFlow.js) trains on the moves you actually threw — more data and more epochs each level — so the opponent reads your habits better as you climb. |
| 🌐 **Multiplayer** | Box a friend live. Create a match, get a link, send it over **WhatsApp** — they tap it and you fight. Two devices, two cameras, real punches; your real face appears on your opponent and gets bruised as you land shots. |

---

## Why we built it

The bottleneck in home fitness is **motivation, not information** — there's endless boxing content but nothing that makes you actually move and keeps you coming back. The Nintendo Wii proved that gamifying exercise gets people off the couch, but it needed controllers and extra hardware. Modern webcam pose estimation is finally good enough to make **the body the controller** with nothing but a laptop and a camera.

We deliberately built a **game**, not a millimetre-perfect form grader. A single webcam can't measure depth, so grading a fast punch's exact joint angles is unreliable — but reliably detecting *"that was a jab, and you slipped in time"* is very doable. Gamifying lowers the accuracy bar while raising fun, retention, and broad appeal.

---

## How it works (architecture)

```
webcam → MoveNet pose (TensorFlow.js, on-device)
       → gesture classifier (velocity + relative-position heuristics)
       → move events: jab | cross | hook | slip | block
       → game loop (training / single-player learning-AI / multiplayer netcode)
       → on-device coach lines  (no server, no key)
```

- **Pose** — `@tensorflow-models/pose-detection` MoveNet *SinglePose Lightning* for fast, real-time skeletons on a normal laptop. (`js/pose.js`)
- **Gestures** — depth-free heuristics on wrist velocity, arm extension (in shoulder-widths), and head offset, with per-move cooldowns. Tuned for *category + timing*, the part that's robust on a webcam. (`js/gestures.js`)
- **Single-player learning AI** — a real neural network (`[lastK moves]→24→16→softmax(next move)`, ~870 weights) **written in plain JavaScript and trained 100% on the CPU — no TensorFlow, no GPU/WebGL.** After each of the 4 levels it runs backprop + SGD on all your moves so far, **warm-started and for more epochs each level** (16 → 42 → 78 → 124 cumulative), so it gets measurably more "trained on you." Training all 4 levels takes ~140 ms on a laptop CPU (well under a second even on a weak phone). In-fight the opponent calls `predict()` and pre-guards your likely next punch; higher levels trust the prediction more. The brain (move history + weights) persists per fighter in localStorage, so returning players face an even smarter opponent. (`js/opponentAI.js`, `js/game.js`)
- **Multiplayer (1v1 / 1v2 / 2v2)** — instead of direct browser-to-browser P2P (which breaks across networks/countries and would need a TURN relay), every player connects **outbound** to a **free public MQTT-over-WebSocket broker** and they exchange **only tiny JSON move/state messages** on a shared room topic. Outbound connections always succeed (like loading any website), so it works **worldwide with zero setup — no TURN, no accounts, no server to host**. Each side runs its own camera + detection locally; **no video is ever transmitted** (only a one-time tiny face thumbnail for the opponent head). The host acts as referee (authoritative HP/damage); a `?room=CODE&fmt=...` link is forwardable over WhatsApp. (`js/multiplayer.js`)
- **Coach** — short, curated boxing-coach lines chosen on-device. No network, no key — the game is fully free and self-contained. (`js/coach.js`)
- **Privacy** — everything runs locally. Your camera feed and pose data never leave your device; multiplayer sends only tiny move messages (and a small face thumbnail) to the people you're fighting.

---

## Run it locally

No build step. You just need a static server (the browser requires HTTPS or `localhost` for webcam access).

```bash
git clone https://github.com/anni-stanford/stanford-fight-club.git
cd stanford-fight-club
npm start          # serves on http://localhost:7788  (uses python3 -m http.server)
# or any static server, e.g.:  npx serve --listen 7788
```

Open `http://localhost:7788`, allow camera access, and pick a mode. No key, no login.

**Multiplayer tip:** create a match on one device, copy the link (or hit *Share on WhatsApp*), and open it on another. Both need their own webcam. Because moves are relayed through a public MQTT broker over outbound WebSocket connections, it works across **different networks/countries with no extra setup** — just host the page over HTTPS (e.g. GitHub Pages) so the browser allows webcam access.

---

## Stack

- TensorFlow.js + MoveNet (pose estimation; uses the GPU via WebGL when available, with a CPU fallback)
- A hand-written, plain-JavaScript neural network (CPU-only, no GPU) — the single-player AI that learns your style
- MQTT over WebSocket via a free public broker (zero-setup, cross-network multiplayer message relay)
- Vanilla HTML/CSS/JS — zero build tooling, fully reproducible

---

## Evaluation & honest limitations

- **Works well:** controlled-speed, front-facing, full-body-in-frame movement — stance, guard, slips, and clean single punches classify reliably.
- **Harder:** full-velocity combos, hands occluding the face, and depth (a single camera can't tell a committed cross from an arm-push). We mitigate this with timing windows and by scoring move *category*, not perfect form.
- **Best practice for players:** stand ~2 m back so your upper body is fully visible, decent lighting, plain-ish background.

---

## 🤖 AI Usage Disclosure

Per CS 153 policy, AI tools were used throughout:

- **Ideation & scoping** — used a chat LLM to rank movement domains for webcam feasibility, pivot from a "form grader" to a *game* (the key insight that makes it work), and shape the multiplayer concept, naming, and pitch.
- **Code generation** — the pose pipeline, gesture heuristics, game loops, WebRTC multiplayer, and UI were written with substantial AI assistance, then reviewed, integrated, and tuned by the author.
- **Runtime AI (on-device)** — the single-player opponent is a real neural network **hand-written in plain JavaScript and trained live on the player's CPU** (no TensorFlow, no GPU, no server) on their own moves; it trains for more epochs each level. No third-party AI service is used at runtime — the game is fully free and self-contained.

All major design decisions, the gesture-detection heuristics, the learning-opponent design, and the netcode fairness model were directed and reviewed by the author. The product, integration, and iteration are the author's own work.

## License

MIT — see [LICENSE](LICENSE).
