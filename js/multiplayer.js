/*
 * multiplayer.js — team boxing (1v1 / 1v2 / 2v2) over a public message relay.
 *
 * WHY THIS WORKS WORLDWIDE WITH NO SETUP:
 * Instead of connecting browsers directly (peer-to-peer, which breaks across
 * different networks/countries and needs a TURN server), every player connects
 * OUTBOUND to a free public MQTT-over-WebSocket broker and they exchange tiny
 * JSON move-messages on a shared room topic. Outbound connections always
 * succeed (like loading any website), so there's no NAT/firewall problem, no
 * TURN, no accounts, nothing to host. The game only sends a few bytes per
 * punch (never video), so a public broker handles it comfortably.
 *
 * Topology: the host is the referee — authoritative for team HP, damage and
 * round flow. Guests publish their moves; the host computes and broadcasts
 * state to the room topic.
 */
window.SB = window.SB || {};

SB.MP = {
  // Free public MQTT brokers (no account). We try them in order.
  BROKERS: [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
  ],

  FORMATS: { "1v1": { A: 1, B: 1 }, "1v2": { A: 1, B: 2 }, "2v2": { A: 2, B: 2 } },

  client: null, isHost: false, roomId: "", topic: "", format: "1v1",
  myId: null, myTeam: null, brokerIdx: 0,
  players: {}, defendedUntil: {}, faces: {},
  teamHP: { A: 100, B: 100 }, teamMax: { A: 100, B: 100 },
  pose: null, gestures: null, active: false, timeLeft: 90, tickId: null,
  _gotLobby: false,

  // ---------- lobby entry ----------
  initLobby() {
    this.lobby = document.getElementById("mp-lobby");
    this.gameWrap = document.getElementById("mp-game");
    this.choices = document.getElementById("mp-choices");
    this.joiningCard = document.getElementById("mp-joining");
    this.joinStatusEl = document.getElementById("mp-join-status");

    document.getElementById("mp-create").onclick = () => this.chooseFormat();
    document.getElementById("mp-join").onclick = () => {
      const code = document.getElementById("mp-join-code").value.trim();
      if (code) this.joinMatch(code);
    };
    document.getElementById("mp-join-retry").onclick = () => this._rejoin();

    this.lobby.hidden = false;
    this.gameWrap.hidden = true;
    this.joiningCard.hidden = true;
    this.choices.hidden = false;
    document.getElementById("mp-share").hidden = true;
  },

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
    this.overlay.querySelectorAll(".fmt").forEach((b) => (b.onclick = () => this.createMatch(b.dataset.fmt)));
  },

  // ---------- host ----------
  createMatch(format) {
    this.isHost = true;
    this.format = format || "1v1";
    this.myId = this._rid("h");
    this.roomId = this._rid("r");
    this.topic = "fightclub/" + this.roomId;
    this.players = {};
    this.players[this.myId] = { id: this.myId, name: this._myName(), avatar: this._myAvatar(), team: "A", ready: false };
    this.myTeam = "A";
    this.faces = {};
    if (this._myFace()) this.faces[this.myId] = this._myFace();
    this._link = location.origin + location.pathname + "?room=" + this.roomId + "&fmt=" + this.format;
    this._waHref = "https://wa.me/?text=" + encodeURIComponent(`Join my ${this.format} fight on Fight Club 🥊 Tap to play: ` + this._link);

    this.overlay.innerHTML = `<div style="font-size:34px">Creating match…</div>`;
    this.overlay.classList.add("show");
    this._connect(() => this._showLobby());
  },

  // ---------- guest ----------
  joinMatch(code) {
    this.isHost = false;
    const q = code.includes("room=") ? new URLSearchParams(code.split("?")[1]) : null;
    this.roomId = (q ? q.get("room") : code).trim();
    this.format = (q && q.get("fmt")) || new URLSearchParams(location.search).get("fmt") || "1v1";
    this.topic = "fightclub/" + this.roomId;
    this.myId = this._rid("g");
    this._gotLobby = false;
    this.faces = {};
    if (this._myFace()) this.faces[this.myId] = this._myFace();

    this.choices.hidden = true;
    this.joiningCard.hidden = false;
    this._setJoinStatus("Connecting…");

    this._connect(() => {
      this._publish({ t: "join", name: this._myName(), avatar: this._myAvatar(), face: this._myFace() });
      // re-announce until the host replies with the lobby (covers late host / lost msg)
      clearInterval(this._joinPing);
      let tries = 0;
      this._joinPing = setInterval(() => {
        if (this._gotLobby || tries++ > 40) { clearInterval(this._joinPing); return; }
        this._setJoinStatus(`Connecting…${tries > 1 ? " (" + tries + ")" : ""}`);
        this._publish({ t: "join", name: this._myName(), avatar: this._myAvatar(), face: this._myFace() });
      }, 1500);
    });
  },

  _rejoin() {
    try { if (this.client) this.client.end(true); } catch (e) {}
    this.client = null; this.brokerIdx = 0;
    if (this.isHost) this.createMatch(this.format);
    else this.joinMatch(this.roomId + "?room=" + this.roomId + "&fmt=" + this.format);
  },

  // ---------- transport (MQTT over WebSocket) ----------
  _connect(onReady) {
    const url = this.BROKERS[this.brokerIdx % this.BROKERS.length];
    const opts = {
      clientId: "fc_" + this.myId + "_" + Math.random().toString(16).slice(2, 8),
      clean: true, connectTimeout: 8000, reconnectPeriod: 2500, keepalive: 30,
    };
    // host announces its departure to the room if it drops
    if (this.isHost) opts.will = { topic: this.topic, payload: JSON.stringify({ t: "hostleft", from: this.myId }), qos: 0 };

    try { this.client = mqtt.connect(url, opts); }
    catch (e) { this._brokerFail(onReady); return; }

    let opened = false;
    const failTimer = setTimeout(() => { if (!opened) this._brokerFail(onReady); }, 9000);

    this.client.on("connect", () => {
      opened = true; clearTimeout(failTimer);
      this.client.subscribe(this.topic, { qos: 0 }, () => onReady && onReady());
    });
    this.client.on("message", (t, payload) => {
      try {
        // browser payloads are Uint8Array; decode as UTF-8 (NOT .toString())
        const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
        this._onMessage(JSON.parse(text));
      } catch (e) {}
    });
    this.client.on("error", () => {});
    this.client.on("close", () => {});
  },

  _brokerFail(onReady) {
    // try the next public broker before giving up
    try { if (this.client) this.client.end(true); } catch (e) {}
    this.brokerIdx++;
    if (this.brokerIdx < this.BROKERS.length) { this._connect(onReady); return; }
    this.brokerIdx = 0;
    if (this.isHost) this.overlay.innerHTML = `Network issue<div class="sub">Couldn't reach the match relay. Check your connection and try again.</div>`;
    else this._setJoinStatus("Couldn't reach the relay — tap Retry.");
  },

  _publish(obj) {
    if (!this.client) return;
    obj.from = this.myId;
    try { this.client.publish(this.topic, JSON.stringify(obj), { qos: 0 }); } catch (e) {}
  },

  _onMessage(m) {
    if (!m || m.from === this.myId) return; // ignore our own echoes

    if (this.isHost) {
      if (m.t === "join") {
        if (!this.players[m.from]) {
          const sizes = this.FORMATS[this.format];
          const countA = Object.values(this.players).filter((p) => p.team === "A").length;
          const team = countA < sizes.A ? "A" : "B";
          this.players[m.from] = { id: m.from, name: (m.name || "Fighter").slice(0, 18), avatar: m.avatar || "🥊", team, ready: false };
        } else {
          this.players[m.from].name = (m.name || "Fighter").slice(0, 18);
          this.players[m.from].avatar = m.avatar || "🥊";
        }
        if (m.face) this.faces[m.from] = m.face;
        this._broadcastLobby();
        this._publish({ t: "faces", faces: this.faces }); // share everyone's faces with the room
      } else if (m.t === "ready") {
        if (this.players[m.from]) this.players[m.from].ready = true;
        this._broadcastLobby(); this._hostMaybeStart();
      } else if (m.t === "myface") {
        if (m.face) { this.faces[m.from] = m.face; this._publish({ t: "faces", faces: this.faces }); this._renderFoeFace(); }
      } else if (m.t === "leave") {
        delete this.players[m.from];
        if (!this.active) this._broadcastLobby();
      } else if (m.t === "atk" && this.active) {
        this._refereeAtk(this.players[m.from] ? this.players[m.from].team : "B", m.move);
      } else if (m.t === "def" && this.active) {
        this.defendedUntil[m.from] = performance.now() + 1200;
      }
    } else {
      // guest only acts on host-origin messages
      if (m.t === "faces") { Object.assign(this.faces, m.faces || {}); this._renderFoeFace(); return; }
      if (m.t === "lobby") {
        this._gotLobby = true; clearInterval(this._joinPing);
        this.players = m.players; this.format = m.format;
        const me = this.players[this.myId];
        this.myTeam = me ? me.team : "B";
        if (this.gameWrap.hidden) this._enterStage();
        this._showLobby();
      } else if (m.t === "start") { this._beginCountdown(); }
      else if (m.t === "hp") { this.teamHP = m.hp; this.teamMax = m.max; this._renderHP(); this._flashFoe(); }
      else if (m.t === "end") { this._finish(m.winTeam); }
      else if (m.t === "hostleft") { this._hostLeft(); }
    }
  },

  _setJoinStatus(t) { if (this.joinStatusEl) this.joinStatusEl.textContent = t; },

  // ---------- lobby UI ----------
  _broadcastLobby() {
    this._publish({ t: "lobby", players: this.players, format: this.format });
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
       <div class="sub">${full ? (allReady ? "All ready! Starting…" : "Everyone in — press Ready.") : "Waiting for players to join…"}</div>
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
    if (this.players[this.myId]) this.players[this.myId].ready = true;
    if (this.isHost) { this._broadcastLobby(); this._hostMaybeStart(); }
    else { this._publish({ t: "ready" }); this._showLobby(); }
  },

  _hostMaybeStart() {
    const sizes = this.FORMATS[this.format];
    const list = Object.values(this.players);
    if (list.length >= sizes.A + sizes.B && list.every((p) => p.ready)) {
      this.teamMax = { A: sizes.A * 100, B: sizes.B * 100 };
      this.teamHP = { A: this.teamMax.A, B: this.teamMax.B };
      this._publish({ t: "start" });
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
    let faceTries = 0;
    try {
      await this.pose.start((kp) => {
        this.gestures.feed(kp);
        // Auto-snap a TIGHT head shot from the live feed so the opponent sees a
        // real cropped face (not an emoji, and not an old loose/torso crop).
        if (this._needFreshFace() && faceTries < 150 && SB.Face && SB.Face.grabFace) {
          faceTries++;
          const url = SB.Face.grabFace(this.video, kp);
          if (url) this._sendMyFace(url);
        }
      });
    }
    catch (e) { this.overlay.innerHTML = `Camera needed<div class="sub">Allow camera access to fight.</div>`; return; }
    this.overlay.classList.remove("show");
    this.overlay.innerHTML = "";
    this.active = true;
    this.timeLeft = 90;
    this._labelBars();
    this._renderFoeFace();
    if (this.isHost) {
      this._publish({ t: "hp", hp: this.teamHP, max: this.teamMax });
      this._renderHP();
      this.tickId = setInterval(() => this._tick(), 1000);
    }
    SB.Coach.say("intro", "live team match starting", (t) => (this.coachEl.textContent = t));
  },

  _onLocalMove(move) {
    if (!this.active) return;
    if (move === "slip" || move === "block") {
      if (this.isHost) this.defendedUntil[this.myId] = performance.now() + 1200;
      else this._publish({ t: "def", move });
      this._float("✓ " + SB.MOVE_LABEL[move], "var(--green)", 0.3, 0.6);
    } else {
      if (this.isHost) this._refereeAtk(this.myTeam, move);
      else this._publish({ t: "atk", move });
      this._float(SB.MOVE_LABEL[move] + "!", "var(--accent2)", 0.7, 0.4);
    }
  },

  _refereeAtk(attackerTeam, move) {
    const enemy = attackerTeam === "A" ? "B" : "A";
    const base = move === "jab" ? 5 : move === "cross" ? 9 : 12;
    const now = performance.now();
    const enemyDefending = Object.values(this.players).some((p) => p.team === enemy && (this.defendedUntil[p.id] || 0) > now);
    const dmg = enemyDefending ? Math.round(base * 0.2) : base;
    this.teamHP[enemy] = Math.max(0, this.teamHP[enemy] - dmg);
    this._publish({ t: "hp", hp: this.teamHP, max: this.teamMax });
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

  _endMatch(winTeam) {
    if (!this.active) return;
    this._publish({ t: "end", winTeam });
    this._finish(winTeam);
  },

  _finish(winTeam) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.tickId);
    const won = this.myTeam === winTeam;
    this.overlay.innerHTML = won
      ? `🏆 Team ${this.myTeam} Wins!<div class="sub">Great work — you took the round.</div>`
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
    this.foeImg = document.getElementById("mp-foe-img");
    this.foeEmoji = document.getElementById("mp-foe-emoji");
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
    this._renderFoeDamage();
  },

  // The opponent head gets progressively more beaten as their team HP drops.
  _renderFoeDamage() {
    if (!this.foeEl) return;
    const mine = this.myTeam || "A", foe = mine === "A" ? "B" : "A";
    const pct = Math.max(0, Math.min(1, this.teamHP[foe] / this.teamMax[foe]));
    const dmg = 1 - pct; // 0 = fresh, 1 = knocked out
    const stage = pct <= 0 ? 5 : dmg < 0.2 ? 0 : dmg < 0.4 ? 1 : dmg < 0.6 ? 2 : dmg < 0.8 ? 3 : 4;
    this.foeEl.style.setProperty("--dmg", dmg.toFixed(2));
    for (let i = 0; i <= 5; i++) this.foeEl.classList.remove("dmg-" + i);
    this.foeEl.classList.add("dmg-" + stage);
  },

  // FACE_VERSION bumps whenever the crop logic changes, so old loose crops get
  // re-captured tightly the next time someone plays a match.
  FACE_VERSION: 2,

  _needFreshFace() {
    if (!this.faces[this.myId]) return true;
    const p = SB.Profile && SB.Profile.current;
    return !(p && (p.faceV || 0) >= this.FACE_VERSION);
  },

  // Broadcast our freshly-captured face so opponents see a real photo.
  _sendMyFace(url) {
    if (!url) return;
    this.faces[this.myId] = url;
    try { if (SB.Profile && SB.Profile.current) SB.Profile.update({ face: url, faceV: this.FACE_VERSION }); } catch (e) {}
    if (this.isHost) this._publish({ t: "faces", faces: this.faces });
    else this._publish({ t: "myface", face: url });
    this._renderFoeFace();
  },

  // Find the opponent we display (first enemy fighter) and show their real face.
  _foeEnemy() {
    const mine = this.myTeam || "A";
    return Object.values(this.players).find((p) => p.team !== mine) || null;
  },

  _renderFoeFace() {
    if (!this.foeEl) return;
    const enemy = this._foeEnemy();
    const face = enemy ? this.faces[enemy.id] : null;
    if (face && this.foeImg) {
      this.foeImg.src = face;
      this.foeImg.hidden = false;
      if (this.foeEmoji) this.foeEmoji.hidden = true;
      this.foeEl.classList.add("has-face");
    } else {
      if (this.foeImg) this.foeImg.hidden = true;
      if (this.foeEmoji) { this.foeEmoji.hidden = false; this.foeEmoji.textContent = (enemy && enemy.avatar) || "🧑"; }
      this.foeEl.classList.remove("has-face");
    }
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

  _rid(prefix) { return (prefix || "") + Math.random().toString(36).slice(2, 10); },
  _myName() { return SB.Profile && SB.Profile.current ? SB.Profile.current.name : "Fighter"; },
  _myAvatar() { return SB.Profile && SB.Profile.current ? SB.Profile.current.avatar : "🥊"; },
  _myFace() { return SB.Profile && SB.Profile.current ? (SB.Profile.current.face || null) : null; },

  stop() {
    this.active = false; this._endedByLeave = false; this._gotLobby = false;
    clearInterval(this.tickId);
    clearInterval(this._joinPing);
    if (this.pose) this.pose.stop();
    this.pose = null;
    try { this._publish({ t: "leave" }); } catch (e) {}
    try { if (this.client) this.client.end(true); } catch (e) {}
    this.client = null;
  },
};

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
