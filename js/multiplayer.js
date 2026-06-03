/*
 * multiplayer.js — team boxing over WebRTC (1v1 / 1v2 / 2v2).
 *
 * Topology: STAR with the host as referee. Every player connects only to the
 * host (PeerJS). The host is authoritative: it tracks team health, applies
 * damage, and broadcasts state to everyone. This scales cleanly from 2 to 4
 * players without an N×N mesh. Each player still runs their OWN webcam + pose
 * detection locally and sends only tiny move messages — no video is transmitted.
 *
 * Flow: Create → pick format → share ONE link → players tap in → they fill team
 * slots in a lobby → everyone readies → 3-2-1 → fight. Team HP is shared; your
 * punches damage the enemy team, your slips/blocks protect yours.
 *
 * NOTE: 3–4 player team modes need testing across that many real devices.
 */
window.SB = window.SB || {};

SB.MP = {
  /*
   * Cross-network play needs a TURN relay (same-WiFi works without one). The free
   * public relays below are best-effort and often rate-limited, so games between
   * different networks/countries can fail. For reliable worldwide play, paste your
   * OWN free TURN credentials into MY_TURN.
   *
   * ── FREE TURN in ~5 min (50 GB/mo, no credit card) ──────────────────────
   *   1. Sign up at https://dashboard.metered.ca  → "TURN Servers".
   *   2. It shows an iceServers array (turn: URLs + username + credential).
   *   3. Paste those objects into MY_TURN below, commit & push. Done.
   * ─────────────────────────────────────────────────────────────────────────
   */
  MY_TURN: [
    // { urls: "turn:standard.relay.metered.ca:80", username: "PASTE", credential: "PASTE" },
    // { urls: "turn:standard.relay.metered.ca:443", username: "PASTE", credential: "PASTE" },
    // { urls: "turn:standard.relay.metered.ca:443?transport=tcp", username: "PASTE", credential: "PASTE" },
  ],

  _peerOpts() {
    return {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
          // best-effort free relays (may be rate-limited):
          { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
          { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
          { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
          ...this.MY_TURN,
        ],
      },
    };
  },

  FORMATS: { "1v1": { A: 1, B: 1 }, "1v2": { A: 1, B: 2 }, "2v2": { A: 2, B: 2 } },

  // session state
  peer: null, isHost: false, roomCode: "", format: "1v1",
  conns: {},            // host: peerId -> DataConnection
  conn: null,           // guest: connection to host
  players: {},          // host-authoritative: peerId -> {id,name,avatar,team,ready}
  myId: null, myTeam: null,
  teamHP: { A: 100, B: 100 }, teamMax: { A: 100, B: 100 },
  defendedUntil: {},    // host: peerId -> ts
  pose: null, gestures: null, active: false, timeLeft: 90, tickId: null,

  // ---------- lobby entry ----------
  initLobby() {
    this.lobby = document.getElementById("mp-lobby");
    this.gameWrap = document.getElementById("mp-game");
    this.choices = document.getElementById("mp-choices");
    this.joiningCard = document.getElementById("mp-joining");
    this.joinStatusEl = document.getElementById("mp-join-status");
    this._joinAttempts = 0;

    document.getElementById("mp-create").onclick = () => this.chooseFormat();
    document.getElementById("mp-join").onclick = () => {
      const code = document.getElementById("mp-join-code").value.trim();
      if (code) this.joinMatch(code);
    };
    document.getElementById("mp-join-retry").onclick = () => { this._joinAttempts = 0; this._tryConnect(); };

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
    this.joiningCard.hidden = true;
    this.choices.hidden = false;
    document.getElementById("mp-share").hidden = true;
  },

  // ---------- host: pick format, then create ----------
  chooseFormat() {
    this._enterStage();
    this.overlay.innerHTML =
      `<div style="font-size:28px;font-weight:700">Choose your match</div>
       <div class="sub">How many fighters per side?</div>
       <div class="format-grid">
         <button class="glass fmt" data-fmt="1v1"><b>1 v 1</b><span>Classic duel</span></button>
         <button class="glass fmt" data-fmt="1v2"><b>1 v 2</b><span>Handicap brawl</span></button>
         <button class="glass fmt" data-fmt="2v2"><b>2 v 2</b><span>Team battle</span></button>
       </div>`;
    this.overlay.classList.add("show");
    this.overlay.querySelectorAll(".fmt").forEach((b) => {
      b.onclick = () => this.createMatch(b.dataset.fmt);
    });
  },

  createMatch(format) {
    this.isHost = true;
    this.format = format || "1v1";
    this.conns = {};
    this.players = {};
    this._link = ""; this._waHref = "#";

    this.peer = new Peer(this._peerOpts());
    this.peer.on("open", (id) => {
      this.roomCode = id; this.myId = id;
      // host takes the first slot on Team A
      this.players[id] = { id, name: this._myName(), avatar: this._myAvatar(), team: "A", ready: false };
      this.myTeam = "A";
      this._link = location.origin + location.pathname + "?room=" + encodeURIComponent(id) + "&fmt=" + this.format;
      this._waHref = "https://wa.me/?text=" + encodeURIComponent(`Join my ${this.format} fight on Fight Club 🥊 Tap to play: ` + this._link);
      this._showLobby();
    });

    this.peer.on("connection", (c) => this._onGuest(c));
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch (e) {} });
    this.peer.on("error", (e) => { if (e.type === "network" || e.type === "disconnected") { try { this.peer.reconnect(); } catch (_) {} } });
  },

  _onGuest(c) {
    c.on("open", () => {
      // assign to the first team with an open slot
      const sizes = this.FORMATS[this.format];
      const countA = Object.values(this.players).filter((p) => p.team === "A").length;
      const team = countA < sizes.A ? "A" : "B";
      this.players[c.peer] = { id: c.peer, name: "Fighter", avatar: "🥊", team, ready: false };
      this.conns[c.peer] = c;
      if (SB.config.hasKey()) c.send({ t: "key", key: SB.config.getKey() });
      c.send({ t: "welcome", you: c.peer, format: this.format });
      this._broadcastLobby();
    });
    c.on("data", (d) => this._hostOnData(c.peer, d));
    c.on("close", () => { delete this.conns[c.peer]; delete this.players[c.peer]; if (this.active) this._broadcastLobby(); else this._showLobby(); });
  },

  // ---------- guest: join ----------
  joinMatch(code) {
    this.isHost = false;
    const q = code.includes("room=") ? new URLSearchParams(code.split("?")[1]) : null;
    this.roomCode = (q ? q.get("room") : code).trim();
    this.format = (q && q.get("fmt")) || new URLSearchParams(location.search).get("fmt") || "1v1";
    this._joinAttempts = 0;

    this.choices.hidden = true;
    this.joiningCard.hidden = false;
    this._setJoinStatus("Connecting to host…");

    this.peer = new Peer(this._peerOpts());
    this.peer.on("open", () => { this.myId = this.peer.id; this._tryConnect(); });
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch (e) {} });
    this.peer.on("error", (e) => {
      if (e.type === "peer-unavailable") this._scheduleRetry();
      else if (e.type === "network" || e.type === "disconnected") { try { this.peer.reconnect(); } catch (_) {} this._scheduleRetry(); }
      else this._setJoinStatus("Error: " + e.type + " — tap Retry.");
    });
  },

  _tryConnect() {
    if (!this.peer || this.peer.destroyed) return;
    this._setJoinStatus(this._joinAttempts ? `Host not ready yet… retrying (${this._joinAttempts})` : "Connecting to host…");
    try {
      this.conn = this.peer.connect(this.roomCode, { reliable: true });
      this.conn.on("open", () => {
        clearTimeout(this._joinTimer); clearTimeout(this._joinRetryTimer);
        this.conn.send({ t: "join", name: this._myName(), avatar: this._myAvatar() });
      });
      this.conn.on("data", (d) => this._guestOnData(d));
      this.conn.on("close", () => this._hostLeft());
    } catch (e) { this._scheduleRetry(); return; }
    clearTimeout(this._joinTimer);
    this._joinTimer = setTimeout(() => { if (!this.conn || !this.conn.open) this._scheduleRetry(); }, 9000);
  },

  _scheduleRetry() {
    clearTimeout(this._joinTimer);
    this._joinAttempts++;
    if (this._joinAttempts > 30) { this._setJoinStatus("Couldn't reach the host. Make sure they have Fight Club open in front, then tap Retry."); return; }
    this._setJoinStatus(`Host not ready yet… retrying (${this._joinAttempts})`);
    clearTimeout(this._joinRetryTimer);
    this._joinRetryTimer = setTimeout(() => this._tryConnect(), 2000);
  },
  _setJoinStatus(t) { if (this.joinStatusEl) this.joinStatusEl.textContent = t; },

  // ---------- message handling ----------
  _hostOnData(fromId, d) {
    if (!d) return;
    if (d.t === "join") {
      if (this.players[fromId]) { this.players[fromId].name = (d.name || "Fighter").slice(0, 18); this.players[fromId].avatar = d.avatar || "🥊"; }
      this._broadcastLobby();
    } else if (d.t === "ready") {
      if (this.players[fromId]) this.players[fromId].ready = true;
      this._broadcastLobby();
      this._hostMaybeStart();
    } else if (d.t === "atk" && this.active) {
      this._refereeAtk(this.players[fromId] ? this.players[fromId].team : "B", d.move);
    } else if (d.t === "def" && this.active) {
      this.defendedUntil[fromId] = performance.now() + 1200;
    }
  },

  _guestOnData(d) {
    if (!d) return;
    if (d.t === "key") { if (!SB.config.hasKey()) { SB.config.setSessionKey(d.key); } return; }
    if (d.t === "welcome") { this.myId = d.you; this.format = d.format; return; }
    if (d.t === "lobby") {
      this.players = d.players; this.format = d.format;
      const me = this.players[this.myId];
      this.myTeam = me ? me.team : "B";
      this._showLobby();
      return;
    }
    if (d.t === "start") { this._beginCountdown(); return; }
    if (d.t === "hp") { this.teamHP = d.hp; this.teamMax = d.max; this._renderHP(); this._flashFoe(); return; }
    if (d.t === "end") { this._finish(d.winTeam); return; }
  },

  // ---------- lobby UI ----------
  _broadcastLobby() {
    const msg = { t: "lobby", players: this.players, format: this.format };
    Object.values(this.conns).forEach((c) => { try { c.send(msg); } catch (e) {} });
    this._showLobby();
  },

  _showLobby() {
    const sizes = this.FORMATS[this.format];
    const list = Object.values(this.players);
    const teamA = list.filter((p) => p.team === "A");
    const teamB = list.filter((p) => p.team === "B");
    const total = sizes.A + sizes.B;
    const full = list.length >= total;
    const allReady = full && list.every((p) => p.ready);
    const me = this.players[this.myId];

    const slotHtml = (arr, size) => {
      let h = "";
      for (let i = 0; i < size; i++) {
        const p = arr[i];
        h += p
          ? `<div class="slot filled${p.id === this.myId ? " me" : ""}">${p.avatar} <span>${escapeHtml(p.name)}${p.ready ? " ✓" : ""}</span></div>`
          : `<div class="slot empty">waiting…</div>`;
      }
      return h;
    };

    this.overlay.innerHTML =
      `<div style="font-size:26px;font-weight:700">${this.format.toUpperCase()} Match</div>
       <div class="lobby-teams">
         <div class="lobby-team"><h4>Team A</h4>${slotHtml(teamA, sizes.A)}</div>
         <div class="lobby-vs">VS</div>
         <div class="lobby-team"><h4>Team B</h4>${slotHtml(teamB, sizes.B)}</div>
       </div>
       ${this.isHost && !full ? `<div class="share-link-row"><input id="mp-ov-link" class="input" readonly><button id="mp-ov-copy" class="btn btn-primary">Copy</button></div>
       <a id="mp-ov-wa" class="btn btn-whatsapp btn-block" target="_blank" rel="noopener">Share invite on WhatsApp</a>` : ""}
       <div class="sub" id="mp-lobby-status">${full ? (allReady ? "All ready! Starting…" : "Everyone in — press Ready.") : "Waiting for players to join…"}</div>
       ${full ? `<button class="btn btn-primary btn-block" id="mp-ready-btn"${me && me.ready ? " disabled style=opacity:.6" : ""}>${me && me.ready ? "Ready ✓" : "✅ I'm Ready"}</button>` : ""}`;
    this.overlay.classList.add("show");

    if (this.isHost && !full) {
      const inp = document.getElementById("mp-ov-link"); if (inp) inp.value = this._link;
      const wa = document.getElementById("mp-ov-wa"); if (wa) wa.href = this._waHref;
      const cp = document.getElementById("mp-ov-copy");
      if (cp) cp.onclick = () => { inp.select(); navigator.clipboard?.writeText(inp.value); cp.textContent = "Copied!"; setTimeout(() => (cp.textContent = "Copy"), 1500); };
    }
    const rb = document.getElementById("mp-ready-btn");
    if (rb && !(me && me.ready)) rb.onclick = () => this._ready();

    if (this.isHost) this._hostMaybeStart();
  },

  _ready() {
    if (this.isHost) { if (this.players[this.myId]) this.players[this.myId].ready = true; this._broadcastLobby(); this._hostMaybeStart(); }
    else { this.conn.send({ t: "ready" }); if (this.players[this.myId]) this.players[this.myId].ready = true; this._showLobby(); }
  },

  _hostMaybeStart() {
    const sizes = this.FORMATS[this.format];
    const list = Object.values(this.players);
    if (list.length >= sizes.A + sizes.B && list.every((p) => p.ready)) {
      this.teamMax = { A: sizes.A * 100, B: sizes.B * 100 };
      this.teamHP = { A: this.teamMax.A, B: this.teamMax.B };
      Object.values(this.conns).forEach((c) => { try { c.send({ t: "start" }); } catch (e) {} });
      this._beginCountdown();
    }
  },

  // ---------- countdown + fight ----------
  _beginCountdown() {
    let n = 3;
    const tick = () => {
      this.overlay.innerHTML = `<div style="font-size:96px">${n}</div>`;
      this.overlay.classList.add("show");
      if (n === 0) { this.overlay.innerHTML = `<div style="font-size:64px">FIGHT!</div>`; setTimeout(() => this._beginRound(), 600); return; }
      n--; setTimeout(tick, 800);
    };
    tick();
  },

  async _beginRound() {
    this.overlay.innerHTML = `<div style="font-size:40px">Starting camera…</div>`;
    try { await this.pose.start((kp) => this.gestures.feed(kp)); }
    catch (e) { this.overlay.innerHTML = `Camera needed<div class="sub">Allow camera access to fight.</div>`; return; }
    this.overlay.classList.remove("show");
    this.overlay.innerHTML = "";
    this.active = true;
    this.timeLeft = 90;
    this._labelBars();
    if (this.isHost) {
      // push the starting team HP so everyone's bars are correct from the bell
      Object.values(this.conns).forEach((c) => { try { c.send({ t: "hp", hp: this.teamHP, max: this.teamMax }); } catch (e) {} });
      this._renderHP();
      this.tickId = setInterval(() => this._tick(), 1000);
    }
    SB.Coach.say("intro", "live team match starting", (t) => (this.coachEl.textContent = t));
  },

  _onLocalMove(move) {
    if (!this.active) return;
    if (move === "slip" || move === "block") {
      if (this.isHost) this.defendedUntil[this.myId] = performance.now() + 1200;
      else this.conn.send({ t: "def", move });
      this._float("✓ " + SB.MOVE_LABEL[move], "var(--green)", 0.3, 0.6);
    } else {
      if (this.isHost) this._refereeAtk(this.myTeam, move);
      else this.conn.send({ t: "atk", move });
      this._float(SB.MOVE_LABEL[move] + "!", "var(--accent2)", 0.7, 0.4);
    }
  },

  // host-only: apply a punch from attackerTeam to the enemy team pool
  _refereeAtk(attackerTeam, move) {
    const enemy = attackerTeam === "A" ? "B" : "A";
    const base = move === "jab" ? 5 : move === "cross" ? 9 : 12;
    const now = performance.now();
    const enemyDefending = Object.values(this.players).some((p) => p.team === enemy && (this.defendedUntil[p.id] || 0) > now);
    const dmg = enemyDefending ? Math.round(base * 0.2) : base;
    this.teamHP[enemy] = Math.max(0, this.teamHP[enemy] - dmg);
    Object.values(this.conns).forEach((c) => { try { c.send({ t: "hp", hp: this.teamHP, max: this.teamMax }); } catch (e) {} });
    this._renderHP(); this._flashFoe();
    if (this.teamHP[enemy] <= 0) this._endMatch(attackerTeam);
  },

  _tick() {
    if (!this.active) return;
    this.timeLeft--;
    if (this.timeLeft <= 0) {
      const aPct = this.teamHP.A / this.teamMax.A, bPct = this.teamHP.B / this.teamMax.B;
      this._endMatch(aPct >= bPct ? "A" : "B");
    }
  },

  _endMatch(winTeam) {   // host authority
    if (!this.active) return;
    Object.values(this.conns).forEach((c) => { try { c.send({ t: "end", winTeam }); } catch (e) {} });
    this._finish(winTeam);
  },

  _finish(winTeam) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.tickId);
    const won = this.myTeam === winTeam;
    this.overlay.innerHTML = won
      ? `🏆 Team ${this.myTeam} Wins!<div class="sub">Great teamwork — you took the round.</div>`
      : `💥 Defeated<div class="sub">Team ${winTeam} took this one. Run it back!</div>`;
    this._menuButton();
    this.overlay.classList.add("show");
    if (this.pose) this.pose.stop();
    if (SB.afterMatch) setTimeout(() => SB.afterMatch({ mode: "multiplayer", won, kos: won ? 1 : 0, score: Math.round((this.teamHP[this.myTeam] / this.teamMax[this.myTeam]) * 100) }), 500);
    SB.Coach.say(won ? "win" : "lose", won ? "won the team match" : "lost the team match",
      (t) => { const s = document.createElement("div"); s.className = "sub"; s.textContent = t; this.overlay.insertBefore(s, this.overlay.querySelector(".end-actions")); });
  },

  // ---------- stage / rendering ----------
  _enterStage() {
    this.lobby.hidden = true;
    this.gameWrap.hidden = false;
    this.video = document.getElementById("mp-video");
    this.canvas = document.getElementById("mp-canvas");
    this.coachEl = document.getElementById("mp-coach");
    this.foeEl = document.getElementById("mp-foe");
    this.telEl = document.getElementById("mp-telegraph");
    this.overlay = document.getElementById("mp-overlay");
    this.stage = this.video.parentElement;
    this.active = false;
    this.pose = new SB.Pose(this.video, this.canvas);
    this.gestures = new SB.Gestures();
    this.gestures.onMove = (m) => this._onLocalMove(m);
  },

  _labelBars() {
    const you = document.querySelector("#mp-game .hb:first-child span");
    const foe = document.querySelector("#mp-game .hb:last-child span");
    if (you) you.textContent = "Team " + (this.myTeam || "A");
    if (foe) foe.textContent = "Team " + (this.myTeam === "A" ? "B" : "A");
    document.getElementById("mp-timer").textContent = this.timeLeft;
  },

  _renderHP() {
    const mine = this.myTeam || "A", foe = mine === "A" ? "B" : "A";
    document.getElementById("mp-hp-you").style.width = (100 * this.teamHP[mine] / this.teamMax[mine]) + "%";
    document.getElementById("mp-hp-foe").style.width = (100 * this.teamHP[foe] / this.teamMax[foe]) + "%";
    document.getElementById("mp-timer").textContent = Math.max(0, this.timeLeft);
  },

  _flashFoe() { if (this.foeEl) { this.foeEl.classList.add("hit"); setTimeout(() => this.foeEl.classList.remove("hit"), 250); } },

  _hostLeft() {
    if (this._endedByLeave) return;
    this._endedByLeave = true;
    this.active = false; clearInterval(this.tickId);
    this.overlay.innerHTML = `👋 Match ended<div class="sub">The host left. Head back and start a new match.</div>`;
    this._menuButton();
    this.overlay.classList.add("show");
    if (this.pose) this.pose.stop();
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

  _float(text, color, xr, yr) {
    const el = document.createElement("div");
    el.className = "hit-float"; el.textContent = text; el.style.color = color;
    el.style.left = (xr * 100) + "%"; el.style.top = (yr * 100) + "%";
    this.stage.appendChild(el); setTimeout(() => el.remove(), 800);
  },

  _myName() { return SB.Profile && SB.Profile.current ? SB.Profile.current.name : "Fighter"; },
  _myAvatar() { return SB.Profile && SB.Profile.current ? SB.Profile.current.avatar : "🥊"; },

  stop() {
    this.active = false; this._endedByLeave = false;
    clearInterval(this.tickId);
    clearTimeout(this._joinTimer); clearTimeout(this._joinRetryTimer);
    if (this.pose) this.pose.stop();
    this.pose = null;
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { Object.values(this.conns).forEach((c) => c.close()); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conn = null; this.conns = {}; this.peer = null;
  },
};

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
