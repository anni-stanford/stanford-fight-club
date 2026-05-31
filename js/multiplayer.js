/*
 * multiplayer.js — two humans, two laptops, two webcams, one match.
 *
 * Networking model (privacy-first): each side runs its OWN webcam + pose
 * detection locally and sends ONLY tiny move/state messages over a WebRTC data
 * channel (via PeerJS). No video is ever transmitted. The host's peer id is the
 * room code; we build a shareable link (?room=CODE) that's forwardable over
 * WhatsApp — the opponent taps it and the fight begins.
 *
 * Fairness: each client is authoritative over its own HP. Your incoming-punch
 * damage is reduced/negated if you slipped or blocked in the last ~1.2s. Each
 * side broadcasts its HP so the other can render the foe bar. Timing windows
 * keep it fair despite network + webcam latency.
 */
window.SB = window.SB || {};

SB.MP = {
  peer: null, conn: null, isHost: false, roomCode: "",
  pose: null, gestures: null, active: false,

  // STUN finds a direct path; TURN relays traffic when the network (e.g. mobile
  // carrier / symmetric NAT) blocks a direct peer-to-peer connection — which is
  // why phone-to-phone needs TURN, not just STUN. OpenRelay is a free TURN.
  PEER_OPTS: {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
      ],
    },
  },

  hpYou: 100, hpFoe: 100, timeLeft: 90,
  defendedUntil: 0, tickId: null,

  // ---------- lobby ----------
  initLobby() {
    this.lobby = document.getElementById("mp-lobby");
    this.gameWrap = document.getElementById("mp-game");
    this.shareCard = document.getElementById("mp-share");
    this.statusEl = document.getElementById("mp-status");
    this.choices = document.getElementById("mp-choices");
    this.joiningCard = document.getElementById("mp-joining");
    this.joinStatusEl = document.getElementById("mp-join-status");
    this._joinAttempts = 0;

    document.getElementById("mp-create").onclick = () => this.createMatch();
    document.getElementById("mp-join").onclick = () => {
      const code = document.getElementById("mp-join-code").value.trim();
      if (code) this.joinMatch(code);
    };
    document.getElementById("mp-join-retry").onclick = () => { this._joinAttempts = 0; this._tryConnect(); };
    document.getElementById("mp-copy").onclick = () => {
      const inp = document.getElementById("mp-link");
      inp.select(); navigator.clipboard?.writeText(inp.value);
      document.getElementById("mp-copy").textContent = "Copied!";
      setTimeout(() => (document.getElementById("mp-copy").textContent = "Copy"), 1500);
    };

    // When the tab comes back to the foreground (e.g. after the host opened
    // WhatsApp to share the link), mobile browsers may have killed the peer's
    // socket — reconnect it so the room is available again.
    if (!this._visBound) {
      this._visBound = true;
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && this.peer && this.peer.disconnected && !this.peer.destroyed) {
          try { this.peer.reconnect(); } catch (e) {}
        }
      });
    }

    this.lobby.hidden = false;
    this.gameWrap.hidden = true;
    this.shareCard.hidden = true;
    this.joiningCard.hidden = true;
    this.choices.hidden = false;
  },

  async createMatch() {
    this.isHost = true;
    this._link = ""; this._waHref = "#";

    // Show the match stage (camera) right away with the share link as an overlay.
    await this._enterMatch();
    this._showHostWaiting();

    // Server-assigned id is far more reliable on the free PeerJS cloud.
    this.peer = new Peer(this.PEER_OPTS);

    this.peer.on("open", (id) => {
      this.roomCode = id;
      this._link = location.origin + location.pathname + "?room=" + encodeURIComponent(id);
      this._waHref = "https://wa.me/?text=" + encodeURIComponent("Fight me on ShadowBox 🥊 Tap to box me live: " + this._link);
      this._fillHostLink();
    });

    this.peer.on("connection", (c) => { this.conn = c; this._wireConn(); });
    // Keep the room alive across mobile backgrounding / network blips.
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch (e) {} });
    this.peer.on("error", (e) => {
      if (e.type === "network" || e.type === "disconnected") { try { this.peer.reconnect(); } catch (_) {} }
    });
  },

  _showHostWaiting() {
    this.overlay.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "match-share";
    wrap.innerHTML =
      `<div style="font-size:30px;font-weight:700">Match ready 🥊</div>
       <div class="sub">Send this link to your opponent. Keep this tab open — the fight starts the moment they join.</div>
       <div class="share-link-row"><input id="mp-ov-link" class="input" readonly value="Creating match…"><button id="mp-ov-copy" class="btn btn-primary">Copy</button></div>
       <a id="mp-ov-wa" class="btn btn-whatsapp btn-block" target="_blank" rel="noopener">Share on WhatsApp</a>
       <div class="sub" id="mp-ov-status">Waiting for opponent to join…</div>`;
    this.overlay.appendChild(wrap);
    this.overlay.classList.add("show");
    document.getElementById("mp-ov-copy").onclick = () => {
      const inp = document.getElementById("mp-ov-link");
      inp.select(); navigator.clipboard?.writeText(inp.value);
      const b = document.getElementById("mp-ov-copy"); b.textContent = "Copied!";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    };
    this._fillHostLink();
  },

  _fillHostLink() {
    const inp = document.getElementById("mp-ov-link");
    const wa = document.getElementById("mp-ov-wa");
    if (inp && this._link) inp.value = this._link;
    if (wa) wa.href = this._waHref || "#";
  },

  joinMatch(code) {
    this.isHost = false;
    this.roomCode = code.replace(/.*room=/, "").trim();
    this._joinAttempts = 0;

    if (this.choices) this.choices.hidden = true;
    if (this.joiningCard) this.joiningCard.hidden = false;
    this._setJoinStatus("Connecting to host…");

    this.peer = new Peer(this.PEER_OPTS);
    this.peer.on("open", () => this._tryConnect());
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch (e) {} });
    this.peer.on("error", (e) => {
      if (e.type === "peer-unavailable") this._scheduleRetry();   // host not ready yet
      else if (e.type === "network" || e.type === "disconnected") { try { this.peer.reconnect(); } catch (_) {} this._scheduleRetry(); }
      else this._setJoinStatus("Error: " + e.type + " — tap Retry.");
    });
  },

  _tryConnect() {
    if (!this.peer || this.peer.destroyed) return;
    this._setJoinStatus(this._joinAttempts ? `Host not ready yet… retrying (${this._joinAttempts})` : "Connecting to host…");
    try {
      this.conn = this.peer.connect(this.roomCode, { reliable: true });
      this._wireConn();
    } catch (e) { this._scheduleRetry(); return; }
    // If the connection doesn't open shortly, the host probably isn't there yet.
    clearTimeout(this._joinTimer);
    this._joinTimer = setTimeout(() => {
      if (!this.conn || !this.conn.open) this._scheduleRetry();
    }, 9000);
  },

  _scheduleRetry() {
    clearTimeout(this._joinTimer);
    this._joinAttempts++;
    if (this._joinAttempts > 30) {
      this._setJoinStatus("Couldn't reach the host. Make sure they have ShadowBox open in the foreground, then tap Retry.");
      return;
    }
    this._setJoinStatus(`Host not ready yet… retrying (${this._joinAttempts})`);
    clearTimeout(this._joinRetryTimer);
    this._joinRetryTimer = setTimeout(() => this._tryConnect(), 2000);
  },

  _setJoinStatus(t) { if (this.joinStatusEl) this.joinStatusEl.textContent = t; },

  _wireConn() {
    this.conn.on("open", async () => {
      clearTimeout(this._joinTimer);
      clearTimeout(this._joinRetryTimer);
      // The inviter (host) shares their OpenAI key so the coach works for BOTH
      // players — the guest never has to enter one. Sent only over this
      // encrypted peer channel and held in memory on the guest's side.
      if (this.isHost && SB.config.hasKey()) {
        this._send({ t: "key", key: SB.config.getKey() });
      }
      // Host already has its camera/stage up (from createMatch); the guest
      // starts its camera now. Both then go to the Ready handshake.
      if (!this.isHost) await this._enterMatch();
      this._showReady();
    });
    this.conn.on("data", (d) => this._onData(d));
    this.conn.on("close", () => this._foeLeft());
  },

  // ---------- enter match: start camera, then wait for BOTH players to ready up ----------
  async _enterMatch() {
    this.lobby.hidden = true;
    this.gameWrap.hidden = false;

    this.video = document.getElementById("mp-video");
    this.canvas = document.getElementById("mp-canvas");
    this.coachEl = document.getElementById("mp-coach");
    this.foeEl = document.getElementById("mp-foe");
    this.telEl = document.getElementById("mp-telegraph");
    this.overlay = document.getElementById("mp-overlay");
    this.stage = this.video.parentElement;

    this.hpYou = 100; this.hpFoe = 100; this.timeLeft = 90; this.defendedUntil = 0;
    this.iAmReady = false; this.foeReady = false; this.active = false;
    this._renderHP(); this._renderTime();

    // Build pose/gesture handlers now, but DON'T turn the camera on yet —
    // it only starts when the round actually begins (after both ready).
    this.pose = new SB.Pose(this.video, this.canvas);
    this.gestures = new SB.Gestures();
    this.gestures.onMove = (m) => this._onLocalMove(m);
    this.coachEl.textContent = "Get set…";
  },

  _showReady() {
    this.overlay.innerHTML = "";
    const title = document.createElement("div");
    title.textContent = "Ready?";
    const sub = document.createElement("div");
    sub.className = "sub"; sub.textContent = "Match starts when you BOTH press ready. Your camera turns on at the bell.";
    const status = document.createElement("div");
    status.className = "sub"; status.id = "mp-ready-status";
    status.textContent = "You: not ready · Opponent: not ready";
    const row = document.createElement("div");
    row.className = "end-actions";
    const btn = document.createElement("button");
    btn.className = "btn btn-primary"; btn.id = "mp-ready-btn"; btn.textContent = "✅ I'm Ready";
    btn.onclick = () => this._setReady();
    row.appendChild(btn);
    this.overlay.appendChild(title);
    this.overlay.appendChild(sub);
    this.overlay.appendChild(status);
    this.overlay.appendChild(row);
    this.overlay.classList.add("show");
  },

  _setReady() {
    if (this.iAmReady) return;
    this.iAmReady = true;
    this._send({ t: "ready" });
    const btn = document.getElementById("mp-ready-btn");
    if (btn) { btn.textContent = "Ready ✓"; btn.disabled = true; btn.style.opacity = ".6"; }
    this._updateReadyStatus();
    this._maybeStart();
  },

  _updateReadyStatus() {
    const s = document.getElementById("mp-ready-status");
    if (s) s.textContent = `You: ${this.iAmReady ? "ready ✓" : "not ready"} · Opponent: ${this.foeReady ? "ready ✓" : "not ready"}`;
  },

  _maybeStart() {
    if (this.iAmReady && this.foeReady) this._countdown();
  },

  _countdown() {
    let n = 3;
    const tick = () => {
      this.overlay.innerHTML = `<div style="font-size:96px">${n}</div>`;
      if (n === 0) { this.overlay.innerHTML = `<div style="font-size:72px">FIGHT!</div>`; setTimeout(() => this._beginRound(), 600); return; }
      n--; setTimeout(tick, 800);
    };
    tick();
  },

  async _beginRound() {
    this.overlay.innerHTML = `<div style="font-size:40px">Starting camera…</div>`;
    // Camera turns on only now, for the actual fight.
    try {
      await this.pose.start((kp) => this.gestures.feed(kp));
    } catch (e) {
      this.overlay.innerHTML = `Camera needed<div class="sub">Allow camera access to fight.</div>`;
      return;
    }
    this.overlay.classList.remove("show");
    this.overlay.innerHTML = "";
    this.active = true;
    SB.Coach.say("intro", "live multiplayer match starting", (t) => (this.coachEl.textContent = t));
    this.tickId = setInterval(() => this._tick(), 1000);
  },

  _onLocalMove(move) {
    if (!this.active) return;
    if (move === "slip" || move === "block") {
      this.defendedUntil = performance.now() + 1200;
      this._float("✓ " + SB.MOVE_LABEL[move], "var(--green)", 0.3, 0.6);
    } else {
      this._send({ t: "atk", move });
      this._float(SB.MOVE_LABEL[move] + "!", "var(--accent2)", 0.7, 0.4);
    }
  },

  _onData(d) {
    if (!d) return;
    // Handshake: accept the host's shared key even before the round is active.
    if (d.t === "key") {
      if (!SB.config.hasKey()) {
        SB.config.setSessionKey(d.key);
        if (this.coachEl) this.coachEl.textContent = "Coach connected via your opponent's key 🥊";
      }
      return;
    }
    if (d.t === "ready") {
      this.foeReady = true;
      this._updateReadyStatus();
      this._maybeStart();
      return;
    }
    if (!this.active) return;
    if (d.t === "atk") {
      const base = d.move === "jab" ? 5 : d.move === "cross" ? 9 : 12;
      const defended = performance.now() < this.defendedUntil;
      const dmg = defended ? Math.round(base * 0.15) : base;
      this.hpYou = Math.max(0, this.hpYou - dmg);
      this.telEl.textContent = (defended ? "BLOCKED " : "HIT! ") + SB.MOVE_LABEL[d.move];
      this.telEl.classList.add("show");
      setTimeout(() => this.telEl.classList.remove("show"), 500);
      if (!defended) {
        this._float("-" + dmg, "var(--accent)", 0.5, 0.7);
        this.stage.animate([{ filter: "brightness(2)" }, { filter: "brightness(1)" }], { duration: 200 });
      }
      this._renderHP();
      this._send({ t: "hp", hp: this.hpYou });
      if (this.hpYou <= 0) this._end(false);
    } else if (d.t === "hp") {
      this.hpFoe = d.hp; this._renderHP();
      this.foeEl.classList.add("hit");
      setTimeout(() => this.foeEl.classList.remove("hit"), 250);
      if (this.hpFoe <= 0) this._end(true);
    } else if (d.t === "end") {
      this._end(d.youWin); // peer tells us the result from their side
    }
  },

  _tick() {
    if (!this.active) return;
    this.timeLeft--;
    this._renderTime();
    if (this.timeLeft <= 0) this._end(this.hpYou >= this.hpFoe);
  },

  _end(won) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.tickId);
    this._send({ t: "end", youWin: !won });
    this.overlay.innerHTML = won
      ? `🏆 You Win!<div class="sub">You out-boxed your opponent. HP left: ${Math.round(this.hpYou)}.</div>`
      : `💥 Defeated<div class="sub">Your opponent took this round.</div>`;
    this._menuButton();
    this.overlay.classList.add("show");
    if (this.pose) this.pose.stop();   // release the camera when the match ends
    SB.Coach.say(won ? "win" : "lose", won ? "won the multiplayer match" : "lost the multiplayer match",
      (t) => { const s = document.createElement("div"); s.className = "sub"; s.textContent = t; this.overlay.insertBefore(s, this.overlay.querySelector(".end-actions")); });
  },

  _menuButton() {
    const row = document.createElement("div");
    row.className = "end-actions";
    const menu = document.createElement("button");
    menu.className = "btn btn-primary"; menu.textContent = "← Back to Menu";
    menu.onclick = () => SB.goMenu();
    row.appendChild(menu);
    this.overlay.appendChild(row);
  },

  _foeLeft() {
    if (!this.active) return;
    this.active = false; clearInterval(this.tickId);
    this.overlay.innerHTML = `👋 Opponent left<div class="sub">They disconnected. Head back and start a new match.</div>`;
    this._menuButton();
    this.overlay.classList.add("show");
    if (this.pose) this.pose.stop();
  },

  _send(obj) { try { if (this.conn && this.conn.open) this.conn.send(obj); } catch (e) {} },
  _renderHP() {
    document.getElementById("mp-hp-you").style.width = this.hpYou + "%";
    document.getElementById("mp-hp-foe").style.width = this.hpFoe + "%";
  },
  _renderTime() { document.getElementById("mp-timer").textContent = Math.max(0, this.timeLeft); },
  _float(text, color, xr, yr) {
    const el = document.createElement("div");
    el.className = "hit-float"; el.textContent = text; el.style.color = color;
    el.style.left = (xr * 100) + "%"; el.style.top = (yr * 100) + "%";
    this.stage.appendChild(el); setTimeout(() => el.remove(), 800);
  },

  stop() {
    this.active = false;
    clearInterval(this.tickId);
    clearTimeout(this._joinTimer);
    clearTimeout(this._joinRetryTimer);
    if (this.pose) this.pose.stop();
    this.pose = null;
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conn = null; this.peer = null;
  },
};
