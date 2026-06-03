/*
 * teammp.js — team multiplayer (1v2 and 2v2; also handles 1v1).
 *
 * Topology: a HOST-AUTHORITATIVE STAR. Everyone connects only to the host
 * (one link for the whole match), so there's no fragile full mesh. The host is
 * the hub and the single source of truth for team HP and the clock; each player
 * detects their own moves locally and sends only tiny messages to the host,
 * who applies damage and broadcasts state to everyone. No video is transmitted.
 *
 * Flow:  Create (pick format) → share ONE link → players tap a team slot →
 *        everyone Ready → 3·2·1 → fight. Team HP is shared per side; your
 *        punches hurt the enemy team; a teammate's slip/block guards your side.
 */
window.SB = window.SB || {};

SB.TeamMP = {
  SIZES: { "1v1": { A: 1, B: 1 }, "1v2": { A: 1, B: 2 }, "2v2": { A: 2, B: 2 } },

  peer: null, isHost: false, format: "2v2", roomCode: "",
  conns: {},          // host: peerId -> DataConnection
  conn: null,         // guest: connection to host
  myId: "", players: [], myTeam: "A",
  pose: null, gestures: null, active: false,
  hpA: 100, hpB: 100, guard: { A: 0, B: 0 }, timeLeft: 90, tickId: null,
  _joinAttempts: 0,

  // ---------- entry points ----------
  createMatch(format) {
    this.format = format; this.isHost = true; this.conns = {}; this.players = [];
    this._grabEls();
    const me = this._me("host");
    me.team = "A"; me.ready = false;
    this.players = [me]; this.myId = "host"; this.myTeam = "A";

    this._showLobby();
    this.shareEl.hidden = false;
    this.statusEl.hidden = true;

    this.peer = new Peer(SB.MP.PEER_OPTS);
    this.peer.on("open", (id) => {
      this.roomCode = id;
      const link = location.origin + location.pathname + "?room=" + encodeURIComponent(id) + "&fmt=" + this.format;
      this.linkEl.value = link;
      this.waEl.href = "https://wa.me/?text=" + encodeURIComponent(`Join my ${this.format} fight on Fight Club 🥊 Tap to play: ${link}`);
      this._renderBoard();
    });
    this.peer.on("connection", (c) => this._hostOnConn(c));
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch (e) {} });
  },

  join(roomId, format) {
    this.format = format || "2v2"; this.isHost = false; this._joinAttempts = 0;
    this._grabEls();
    this._showLobby();
    this.shareEl.hidden = true;
    this.statusEl.hidden = false;
    this.statusEl.textContent = "Connecting to host…";
    this.roomCode = roomId;

    this.peer = new Peer(SB.MP.PEER_OPTS);
    this.peer.on("open", () => this._tryConnect());
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch (e) {} });
    this.peer.on("error", (e) => {
      if (e.type === "peer-unavailable" || e.type === "network" || e.type === "disconnected") this._retry();
    });
  },

  _tryConnect() {
    if (!this.peer || this.peer.destroyed) return;
    this.statusEl.textContent = this._joinAttempts ? `Host not ready… retrying (${this._joinAttempts})` : "Connecting to host…";
    this.conn = this.peer.connect(this.roomCode, { reliable: true });
    this.conn.on("open", () => {
      clearTimeout(this._jt);
      this.conn.send({ t: "hello", name: this._myName(), avatar: this._myAvatar() });
    });
    this.conn.on("data", (d) => this._guestOnData(d));
    this.conn.on("close", () => this._foeLeft());
    clearTimeout(this._jt);
    this._jt = setTimeout(() => { if (!this.conn || !this.conn.open) this._retry(); }, 9000);
  },
  _retry() {
    clearTimeout(this._jt);
    if (++this._joinAttempts > 30) { this.statusEl.textContent = "Couldn't reach host. Make sure they kept the tab open, then reopen the link."; return; }
    this.statusEl.textContent = `Host not ready… retrying (${this._joinAttempts})`;
    setTimeout(() => this._tryConnect(), 2000);
  },

  // ---------- host: connection + assignment ----------
  _hostOnConn(c) {
    this.conns[c.peer] = c;
    c.on("data", (d) => this._hostOnData(c, d));
    c.on("close", () => { this._removePlayer(c.peer); this._broadcastLobby(); this._renderBoard(); });
  },
  _hostOnData(c, d) {
    if (d.t === "hello") {
      if (!this.players.find((p) => p.id === c.peer)) {
        const team = this._autoTeam();
        if (!team) { c.send({ t: "full" }); return; }
        this.players.push({ id: c.peer, name: d.name || "Fighter", avatar: d.avatar || "🥊", team, ready: false });
      }
      c.send({ t: "welcome", you: c.peer, format: this.format });
      this._broadcastLobby(); this._renderBoard();
    } else if (d.t === "pick") {
      const p = this.players.find((x) => x.id === c.peer);
      if (p && this._teamCount(d.team) < this.SIZES[this.format][d.team]) { p.team = d.team; this._broadcastLobby(); this._renderBoard(); }
    } else if (d.t === "ready") {
      const p = this.players.find((x) => x.id === c.peer);
      if (p) p.ready = d.ready; this._broadcastLobby(); this._renderBoard(); this._maybeStart();
    } else if (d.t === "move" && this.active) {
      const p = this.players.find((x) => x.id === c.peer);
      if (p) this._applyMove(p.team, d.move);
    }
  },

  _autoTeam() {
    const s = this.SIZES[this.format];
    const a = this._teamCount("A"), b = this._teamCount("B");
    if (a <= b && a < s.A) return "A";
    if (b < s.B) return "B";
    if (a < s.A) return "A";
    return null;
  },
  _teamCount(t) { return this.players.filter((p) => p.team === t).length; },
  _removePlayer(id) { this.players = this.players.filter((p) => p.id !== id); },
  _full() { const s = this.SIZES[this.format]; return this._teamCount("A") === s.A && this._teamCount("B") === s.B; },
  _allReady() { return this.players.length > 0 && this.players.every((p) => p.ready); },

  _broadcastLobby() {
    const msg = { t: "lobby", players: this.players, format: this.format };
    Object.values(this.conns).forEach((c) => { try { c.send(msg); } catch (e) {} });
  },
  _broadcast(msg) { Object.values(this.conns).forEach((c) => { try { c.send(msg); } catch (e) {} }); },

  _maybeStart() {
    if (this.isHost && this._full() && this._allReady()) {
      this._broadcast({ t: "start" });
      this._countdown();
    }
  },

  // ---------- guest: inbound ----------
  _guestOnData(d) {
    if (d.t === "welcome") { this.myId = d.you; this.format = d.format; }
    else if (d.t === "lobby") { this.players = d.players; this.format = d.format; const me = this.players.find((p) => p.id === this.myId); if (me) this.myTeam = me.team; this.statusEl.hidden = true; this._renderBoard(); }
    else if (d.t === "full") { this.statusEl.hidden = false; this.statusEl.textContent = "This match is full."; }
    else if (d.t === "start") { this._countdown(); }
    else if (d.t === "state") { this.hpA = d.hpA; this.hpB = d.hpB; this.timeLeft = d.time; this._renderFight(); }
    else if (d.t === "end") { this._end(d.winner); }
  },

  // ---------- lobby UI ----------
  _grabEls() {
    this.lobbyEl = document.getElementById("tm-lobby");
    this.gameEl = document.getElementById("tm-game");
    this.shareEl = document.getElementById("tm-share");
    this.statusEl = document.getElementById("tm-join-status");
    this.linkEl = document.getElementById("tm-link");
    this.waEl = document.getElementById("tm-whatsapp");
    this.titleEl = document.getElementById("tm-title");
    this.readyBtn = document.getElementById("tm-ready");
    this.readyStatus = document.getElementById("tm-ready-status");
    document.getElementById("tm-copy").onclick = () => { this.linkEl.select(); navigator.clipboard?.writeText(this.linkEl.value); };
    this.readyBtn.onclick = () => this._toggleReady();
  },
  _showLobby() {
    document.getElementById("mp-lobby").hidden = true;
    document.getElementById("mp-game").hidden = true;
    this.lobbyEl.hidden = false; this.gameEl.hidden = true;
    this.titleEl.textContent = this.format + " Team Match";
  },
  _renderBoard() {
    ["A", "B"].forEach((team) => {
      const wrap = document.getElementById("tm-slots" + team);
      if (!wrap) return;
      wrap.innerHTML = "";
      const size = this.SIZES[this.format][team];
      const inTeam = this.players.filter((p) => p.team === team);
      for (let i = 0; i < size; i++) {
        const p = inTeam[i];
        const slot = document.createElement("div");
        if (p) {
          slot.className = "slot filled" + (p.id === this.myId ? " me" : "");
          slot.innerHTML = `<span class="slot-av">${p.avatar}</span><span class="slot-name">${this._esc(p.name)}${p.isHost || p.id === "host" ? " (host)" : ""}</span>${p.ready ? '<span class="slot-ready">ready ✓</span>' : ""}`;
        } else {
          slot.className = "slot empty";
          slot.innerHTML = `<span class="slot-av">＋</span><span class="slot-name muted">Tap to join Team ${team}</span>`;
          slot.onclick = () => this._pickTeam(team);
        }
        wrap.appendChild(slot);
      }
    });
    const ready = this.players.find((p) => p.id === this.myId);
    this.readyBtn.textContent = ready && ready.ready ? "Ready ✓ (tap to cancel)" : "✅ I'm Ready";
    this.readyStatus.textContent = `${this.players.filter((p) => p.ready).length}/${this.SIZES[this.format].A + this.SIZES[this.format].B} ready · waiting for a full, ready lobby`;
  },

  _pickTeam(team) {
    if (this._teamCount(team) >= this.SIZES[this.format][team]) return;
    if (this.isHost) { const me = this.players.find((p) => p.id === "host"); if (me) { me.team = team; this.myTeam = team; this._broadcastLobby(); this._renderBoard(); } }
    else { this.conn?.send({ t: "pick", team }); }
  },
  _toggleReady() {
    const me = this.players.find((p) => p.id === this.myId);
    if (!me) return;
    me.ready = !me.ready;
    if (this.isHost) { this._broadcastLobby(); this._renderBoard(); this._maybeStart(); }
    else { this.conn?.send({ t: "ready", ready: me.ready }); this._renderBoard(); }
  },

  // ---------- countdown + fight ----------
  async _countdown() {
    this.lobbyEl.hidden = true; this.gameEl.hidden = false;
    this._grabFightEls();
    this.overlay.classList.add("show");
    // start camera now (privacy: only during the actual fight)
    this.pose = new SB.Pose(this.video, this.canvas);
    this.gestures = new SB.Gestures();
    this.gestures.onMove = (m) => this._localMove(m);
    try { await this.pose.start((kp) => this.gestures.feed(kp)); }
    catch (e) { this.overlay.innerHTML = "Camera needed to fight."; return; }

    let n = 3;
    const tick = () => {
      this.overlay.innerHTML = n > 0 ? `<div style="font-size:96px">${n}</div>` : `<div style="font-size:64px">FIGHT!</div>`;
      if (n <= 0) { setTimeout(() => this._begin(), 600); return; }
      n--; setTimeout(tick, 800);
    };
    tick();
  },

  _begin() {
    this.overlay.classList.remove("show"); this.overlay.innerHTML = "";
    this.hpA = 100; this.hpB = 100; this.guard = { A: 0, B: 0 }; this.timeLeft = 90;
    this.active = true;
    this._renderFight();
    SB.Coach.say("intro", "team match starting", (t) => (this.coachEl.textContent = t));
    if (this.isHost) {
      this._renderFight();
      this.tickId = setInterval(() => {
        this.timeLeft--;
        this._broadcast({ t: "state", hpA: this.hpA, hpB: this.hpB, time: this.timeLeft });
        this._renderFight();
        if (this.timeLeft <= 0) this._finish();
      }, 1000);
    }
  },

  _localMove(m) {
    if (!this.active) return;
    if (this.isHost) this._applyMove(this.myTeam, m);
    else this.conn?.send({ t: "move", move: m });
    // local feedback
    if (m === "slip" || m === "block") this._float("✓ " + SB.MOVE_LABEL[m], "var(--green)", 0.3, 0.6);
    else this._float(SB.MOVE_LABEL[m] + "!", "var(--accent2)", 0.7, 0.4);
  },

  // host authority: apply a move from a given team
  _applyMove(team, m) {
    if (!this.active || !this.isHost) return;
    const enemy = team === "A" ? "B" : "A";
    if (m === "slip" || m === "block") { this.guard[team] = performance.now() + 1000; return; }
    const base = m === "jab" ? 5 : m === "cross" ? 9 : 12;
    const dmg = performance.now() < this.guard[enemy] ? Math.round(base * 0.3) : base;
    if (enemy === "A") this.hpA = Math.max(0, this.hpA - dmg); else this.hpB = Math.max(0, this.hpB - dmg);
    this._broadcast({ t: "state", hpA: this.hpA, hpB: this.hpB, time: this.timeLeft });
    this._renderFight();
    if (this.hpA <= 0 || this.hpB <= 0) this._finish();
  },

  _finish() {
    if (!this.isHost || !this.active) return;
    const winner = this.hpA === this.hpB ? "draw" : (this.hpA > this.hpB ? "A" : "B");
    this._broadcast({ t: "end", winner });
    this._end(winner);
  },

  _renderFight() {
    if (!this.fightReady) return;
    const mine = this.myTeam, foe = mine === "A" ? "B" : "A";
    const myHP = mine === "A" ? this.hpA : this.hpB;
    const foeHP = foe === "A" ? this.hpA : this.hpB;
    document.getElementById("tm-hp-a").style.width = myHP + "%";
    document.getElementById("tm-hp-b").style.width = foeHP + "%";
    document.getElementById("tm-timer").textContent = Math.max(0, this.timeLeft);
  },

  _end(winner) {
    if (!this.active) return;
    this.active = false; clearInterval(this.tickId);
    const won = winner === this.myTeam;
    if (this.pose) this.pose.stop();
    this.overlay.innerHTML = winner === "draw"
      ? `🤝 Draw!<div class="sub">Even fight.</div>`
      : won ? `🏆 Your team wins!<div class="sub">Great teamwork.</div>` : `💥 Defeated<div class="sub">Your team went down — rematch?</div>`;
    const row = document.createElement("div"); row.className = "end-actions";
    const menu = document.createElement("button"); menu.className = "btn btn-primary"; menu.textContent = "← Back to Menu"; menu.onclick = () => SB.goMenu();
    row.appendChild(menu); this.overlay.appendChild(row);
    this.overlay.classList.add("show");
    if (SB.afterMatch && winner !== "draw") setTimeout(() => SB.afterMatch({ mode: "multiplayer", won, kos: won ? 1 : 0, score: Math.round(this.myTeam === "A" ? this.hpA : this.hpB) }), 400);
  },

  _foeLeft() {
    if (this.active) { /* keep going; host handles HP */ }
  },

  _grabFightEls() {
    this.video = document.getElementById("tm-video");
    this.canvas = document.getElementById("tm-canvas");
    this.coachEl = document.getElementById("tm-coach");
    this.overlay = document.getElementById("tm-overlay");
    this.stage = this.video.parentElement;
    document.getElementById("tm-hp-a-label").textContent = "Your team";
    document.getElementById("tm-hp-b-label").textContent = "Enemy team";
    this.fightReady = true;
  },

  _float(text, color, xr, yr) {
    if (!this.stage) return;
    const el = document.createElement("div"); el.className = "hit-float"; el.textContent = text; el.style.color = color;
    el.style.left = (xr * 100) + "%"; el.style.top = (yr * 100) + "%";
    this.stage.appendChild(el); setTimeout(() => el.remove(), 800);
  },

  _me(id) { return { id, name: this._myName(), avatar: this._myAvatar(), team: "A", ready: false, isHost: id === "host" }; },
  _myName() { return SB.Profile.current ? SB.Profile.current.name : "Fighter"; },
  _myAvatar() { return SB.Profile.current ? SB.Profile.current.avatar : "🥊"; },
  _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); },

  stop() {
    this.active = false; clearInterval(this.tickId); clearTimeout(this._jt);
    if (this.pose) this.pose.stop(); this.pose = null;
    try { Object.values(this.conns).forEach((c) => c.close()); } catch (e) {}
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conns = {}; this.conn = null; this.peer = null; this.fightReady = false;
    if (this.lobbyEl) this.lobbyEl.hidden = true;
    if (this.gameEl) this.gameEl.hidden = true;
  },
};
