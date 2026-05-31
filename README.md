# 🥊 Stanford Fight Club

**Stanford Fight Club (ShadowBox)** makes staying fit genuinely fun. It turns your webcam into a boxing ring — no controller, no gym, no gear. Square up to your screen and fight an AI opponent or a friend across the internet who reacts to your every move, building fitness, reflexes, and real boxing skills while you play. **Your body is the controller. Step in and throw down.**

> 🎓 **This project was built while working on the CS 153 project** (*The One-Person Frontier Lab*). Built solo with heavy AI assistance (see [AI Usage](#-ai-usage-disclosure)).

---

## What it does

ShadowBox runs entirely in your browser. A webcam + real-time pose estimation reads your movement, a lightweight gesture classifier turns it into boxing moves (**jab, cross, hook, slip, block**), and a game loop reacts to you in real time.

Three modes:

| Mode | What happens |
|------|--------------|
| 🎯 **Training** | The coach calls out moves and grades your timing/accuracy rep by rep. The "boxing tutor" layer. |
| 🤖 **Single Player** | Fight a reactive AI that *telegraphs* attacks. Slip or block in the reaction beat, then counter. 90-second round, most HP wins. |
| 🌐 **Multiplayer** | Box a friend live. Create a match, get a link, send it over **WhatsApp** — they tap it and you fight. Two laptops, two cameras, real punches. |

An optional **OpenAI-powered coach** gives live, spoken-style commentary and corrections.

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
       → game loop (training / single-player AI / multiplayer netcode)
       → OpenAI coach (optional, text-only commentary)
```

- **Pose** — `@tensorflow-models/pose-detection` MoveNet *SinglePose Lightning* for fast, real-time skeletons on a normal laptop. (`js/pose.js`)
- **Gestures** — depth-free heuristics on wrist velocity, arm extension (in shoulder-widths), and head offset, with per-move cooldowns. Tuned for *category + timing*, the part that's robust on a webcam. (`js/gestures.js`)
- **Single player** — the AI **telegraphs** an attack and gives you a reaction beat; timing windows hide webcam/processing latency. (`js/game.js`)
- **Multiplayer** — **WebRTC via PeerJS**. Each side runs its own camera + detection locally and sends **only tiny move/state messages** over a data channel — **no video is ever transmitted**, which keeps it private, low-bandwidth, and avoids syncing two video streams. The host's peer id is the room code; a `?room=CODE` link is forwardable over WhatsApp. (`js/multiplayer.js`)
- **Coach** — OpenAI Chat Completions (`gpt-4o-mini`), throttled, always with a local fallback line so the game is fully playable with no key/network. Only a short text summary is sent — never video or pose data. (`js/coach.js`)
- **Privacy** — the OpenAI key is stored only in your browser's `localStorage` and is sent only to OpenAI.

---

## Run it locally

No build step. You just need a static server (the browser requires HTTPS or `localhost` for webcam access).

```bash
git clone https://github.com/anni-stanford/shadowbox.git
cd shadowbox
npm start          # serves on http://localhost:7788  (uses python3 -m http.server)
# or any static server, e.g.:  npx serve --listen 7788
```

Open `http://localhost:7788`, allow camera access, (optionally) paste an OpenAI key, and pick a mode.

**Multiplayer tip:** create a match on one laptop, copy the link (or hit *Share on WhatsApp*), and open it on a second laptop. Both need their own webcam. For two devices on different networks, host over HTTPS (e.g. GitHub Pages / any static host) so WebRTC can connect.

---

## Stack

- TensorFlow.js + MoveNet (pose estimation)
- PeerJS / WebRTC (peer-to-peer multiplayer)
- OpenAI API (optional coach commentary)
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
- **Runtime AI** — the in-app coach uses the OpenAI API for live commentary (optional; disabled gracefully without a key).

All major design decisions, the gesture-detection heuristics, and the netcode fairness model were directed and reviewed by the author. The product, integration, and iteration are the author's own work.

## License

MIT — see [LICENSE](LICENSE).
