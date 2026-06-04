/*
 * game.js — Single-player CAMPAIGN vs an AI that learns your style.
 *
 * 4 levels. Between every level we train a real neural network (SB.OpponentAI,
 * TensorFlow.js) on the moves YOU actually threw — more data and more epochs
 * each level — so the opponent gets progressively more "trained on you":
 *
 *   Level 1: fresh brain (basic, mostly reactive).
 *   Level 2: brain trained on your Level 1 moves.
 *   Level 3: trained on Level 1+2, for more epochs  -> sharper.
 *   Level 4: trained on Level 1+2+3, even more epochs -> reads you best.
 *
 * In-fight the brain predicts your next move and the boxer reacts (guards your
 * favorite punches, baits your habits). Higher levels trust the prediction more.
 *
 * The webcam game-design trick still applies: the opponent TELEGRAPHS attacks
 * and gives you a beat to slip/block, which hides webcam latency and only needs
 * the move *category* (reliable on a single camera).
 */
window.SB = window.SB || {};

SB.Single = {
  pose: null, gestures: null, active: false,
  hpYou: 100, hpAI: 100, timeLeft: 30,
  aiState: "idle", aiGuard: false, defended: false,
  tickId: null, _reactBusy: false,

  MAX_LEVEL: 4,
  ROUND_SECS: 30,
  level: 1,
  _runId: 0,        // bumps on stop()/restart so async loops can bail out
  _lossRecorded: false,

  SPRITE: {
    idle: "assets/boxer-idle.png",
    attack: "assets/boxer-attack.png",
    block: "assets/boxer-block.png",
    jab: "assets/boxer-hit-jab.png",
    cross: "assets/boxer-hit-cross.png",
    hook: "assets/boxer-hit-hook.png",
    ko: "assets/boxer-ko.png",
  },

  _setSprite(state, reactClass) {
    if (!this.foeEl) return;
    const src = this.SPRITE[state] || this.SPRITE.idle;
    if (!this.foeEl.src.endsWith(src)) this.foeEl.src = src;
    this.foeEl.classList.remove("attack", "guard", "react-jab", "react-cross", "react-hook");
    if (reactClass) { void this.foeEl.offsetWidth; this.foeEl.classList.add(reactClass); }
  },

  _react(move) {
    this._reactBusy = true;
    if (move === "jab") this._setSprite("jab", "react-jab");
    else if (move === "cross") this._setSprite("cross", "react-cross");
    else if (move === "hook") this._setSprite("hook", "react-hook");
    const back = move === "jab" ? 340 : 600;
    clearTimeout(this._recoverT);
    this._recoverT = setTimeout(() => {
      this._reactBusy = false;
      if (this.active) this._setSprite(this.aiGuard ? "block" : "idle");
    }, back);
  },

  async start() {
    this.video = document.getElementById("single-video");
    this.canvas = document.getElementById("single-canvas");
    this.coachEl = document.getElementById("single-coach");
    this.foeEl = document.getElementById("single-foe");
    this.telEl = document.getElementById("single-telegraph");
    this.overlay = document.getElementById("single-overlay");
    this.levelEl = document.getElementById("single-level");
    this.aiEl = document.getElementById("single-ai");
    this.stage = this.video.parentElement;

    this.level = 1;
    this._lossRecorded = false;
    this._runId++;
    this._reactBusy = false;
    this.overlay.classList.remove("show");
    this._setSprite("idle");

    // Load this fighter's AI brain (persists across sessions and keeps learning).
    const pid = (SB.Profile && SB.Profile.current) ? SB.Profile.current.id : "guest";
    this.coachEl.textContent = "Loading your AI opponent…";
    try { if (SB.OpponentAI) await SB.OpponentAI.init(pid); } catch (e) {}

    this.pose = new SB.Pose(this.video, this.canvas);
    this.gestures = new SB.Gestures();
    this.gestures.onMove = (m, meta) => this._onPlayerMove(m, meta);

    this.coachEl.textContent = "Starting camera…";
    try {
      await this.pose.start((kp) => this.gestures.feed(kp));
    } catch (e) {
      this.coachEl.textContent = "Camera access is required to fight. Allow it and reopen.";
      return;
    }
    this._renderAIChip();
    this._startLevel(1);
  },

  _startLevel(n) {
    this.level = n;
    this.hpYou = 100;
    this.hpAI = 60 + n * 20;          // 80 / 100 / 120 / 140 — tougher each level
    this.hpAImax = this.hpAI;
    this.timeLeft = this.ROUND_SECS;
    this.aiState = "idle"; this.aiGuard = false; this.defended = false;
    this.active = true;
    this._renderHP(); this._renderTime(); this._renderLevel();
    this._setSprite("idle");

    // Level intro banner.
    const trained = SB.OpponentAI ? SB.OpponentAI.stats() : { moves: 0, epochs: 0 };
    const blurb = n === 1
      ? "Fresh AI brain. Show it what you've got."
      : `AI retrained on your ${trained.moves} moves (${trained.epochs} epochs). It knows you better now.`;
    this.overlay.innerHTML = `LEVEL ${n}<div class="sub">${blurb}</div>`;
    this.overlay.classList.add("show");
    const runId = this._runId;
    setTimeout(() => {
      if (runId !== this._runId || !this.active) return;
      this.overlay.classList.remove("show");
      this.tickId = setInterval(() => this._tick(), 1000);
      this._aiBrain();
    }, 1600);
  },

  _onPlayerMove(move) {
    if (!this.active) return;
    // Feed EVERY move to the learning brain (this is its training data).
    if (SB.OpponentAI) SB.OpponentAI.record(move);

    if (move === "jab" || move === "cross" || move === "hook") {
      const base = move === "jab" ? 5 : move === "cross" ? 9 : 12;
      const dmg = this.aiGuard ? Math.round(base * 0.2) : base;
      this.hpAI = Math.max(0, this.hpAI - dmg);
      this._float(this.aiGuard ? "BLOCKED" : "-" + dmg, this.aiGuard ? "#8fa" : "var(--accent2)", 0.5, 0.32);
      if (!this.aiGuard) this._react(move);
      this._renderHP();
      if (this.hpAI <= 0) this._endLevel(true);
    } else if (move === "slip" || move === "block") {
      if (this.aiState === "telegraph" || this.aiState === "striking") {
        this.defended = true;
        this._float("✓ " + SB.MOVE_LABEL[move], "var(--green)", 0.3, 0.5);
      }
    }
  },

  // The trained brain drives the opponent: predict your next move, then react.
  async _aiBrain() {
    const runId = this._runId;
    const level = this.level;
    while (this.active && runId === this._runId) {
      const think = Math.max(450, 1000 - level * 110) + Math.random() * 850;
      await this._sleep(think);
      if (!this.active || runId !== this._runId) break;

      const pred = SB.OpponentAI ? SB.OpponentAI.predict() : null;
      const trust = Math.min(0.85, 0.22 + 0.18 * level); // higher levels trust the model more
      this._renderAIChip(pred);

      const predAttack = pred && (pred.move === "jab" || pred.move === "cross" || pred.move === "hook");
      // Anticipatory defense: if the brain thinks you're about to punch, it guards.
      if (predAttack && pred.prob > 0.45 && Math.random() < trust) {
        this.aiGuard = true;
        if (!this._reactBusy) this._setSprite("block");
        this.telEl.textContent = "READING YOU…";
        this.telEl.classList.add("show");
        await this._sleep(650 + level * 60);
        this.telEl.classList.remove("show");
        this.aiGuard = false;
        if (!this._reactBusy) this._setSprite("idle");
        if (this.active && Math.random() < 0.45 + 0.12 * level) await this._attack(level);
        continue;
      }
      await this._attack(level);
    }
  },

  async _attack(level) {
    const runId = this._runId;
    this.aiState = "telegraph"; this.defended = false;
    const attack = Math.random() < 0.5 ? "JAB" : Math.random() < 0.5 ? "CROSS" : "HOOK";
    this.telEl.textContent = attack + " INCOMING";
    this.telEl.classList.add("show");
    if (!this._reactBusy) this._setSprite("attack");
    this.foeEl.classList.add("attack");

    const reactWindow = Math.max(560, 1100 - level * 120); // faster punches at higher level
    await this._sleep(reactWindow);
    if (!this.active || runId !== this._runId) return;

    this.aiState = "striking";
    this.telEl.classList.remove("show");
    this.foeEl.classList.remove("attack");
    if (!this._reactBusy) this._setSprite("idle");
    if (!this.defended) {
      const dmg = (5 + level * 2) + Math.floor(Math.random() * 6);
      this.hpYou = Math.max(0, this.hpYou - dmg);
      this._float("-" + dmg, "var(--accent)", 0.5, 0.7);
      this.stage.animate([{ filter: "brightness(2.2)" }, { filter: "brightness(1)" }], { duration: 220 });
      this._renderHP();
      if (Math.random() < 0.4) SB.Coach.say("fix", "took a clean shot", (t) => (this.coachEl.textContent = t));
      if (this.hpYou <= 0) { this._endLevel(false); return; }
    } else if (Math.random() < 0.4) {
      SB.Coach.say("good", "great defense", (t) => (this.coachEl.textContent = t));
    }
    this.aiState = "idle";

    // Post-attack guard window (defends your shots), longer at higher levels.
    if (Math.random() < 0.35 + 0.1 * level) {
      this.aiGuard = true;
      if (!this._reactBusy) this._setSprite("block");
      await this._sleep(600);
      this.aiGuard = false;
      if (!this._reactBusy && this.active) this._setSprite("idle");
    }
  },

  _tick() {
    if (!this.active) return;
    this.timeLeft--;
    this._renderTime();
    if (this.timeLeft <= 0) this._endLevel(this.hpYou >= this.hpAI);
  },

  _endLevel(won) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.tickId);
    clearTimeout(this._recoverT);
    this._reactBusy = true;

    if (won && this.level < this.MAX_LEVEL) { this._trainThenNext(); return; }
    if (won && this.level >= this.MAX_LEVEL) { this._campaignWin(); return; }
    this._levelLost();
  },

  // Between levels: actually train the neural net on the player's moves.
  async _trainThenNext() {
    const runId = this._runId;
    const finished = this.level;
    this._setSprite("idle");
    this.overlay.innerHTML =
      `🧠 Training the AI on your moves
       <div class="sub" id="train-sub">Learning your Level ${finished} patterns…</div>
       <div class="train-bar"><i id="train-bar-i"></i></div>
       <div class="sub train-stat" id="train-stat">Building dataset…</div>`;
    this.overlay.classList.add("show");
    const bar = document.getElementById("train-bar-i");
    const stat = document.getElementById("train-stat");

    let stats = null;
    try {
      stats = await SB.OpponentAI.trainForLevel(finished, (p, info) => {
        if (bar) bar.style.width = Math.round(p * 100) + "%";
        if (stat && info && !info.skipped) stat.textContent = `epoch ${Math.round(p * (16 + (finished - 1) * 10))} · loss ${info.loss != null ? info.loss.toFixed(3) : "—"} · acc ${(info.acc != null ? Math.round(info.acc * 100) : 0)}%`;
      });
    } catch (e) {}
    if (runId !== this._runId) return; // user left during training

    const s = stats || (SB.OpponentAI ? SB.OpponentAI.stats() : { moves: 0, epochs: 0 });
    this.overlay.innerHTML =
      `✅ AI Upgraded
       <div class="sub">Now trained on <b>${s.moves}</b> of your moves over <b>${s.epochs}</b> epochs.</div>
       <div class="sub">Level ${finished + 1} opponent will read you better. Get ready…</div>`;
    this._renderAIChip();
    setTimeout(() => { if (runId === this._runId) this._startLevel(finished + 1); }, 2100);
  },

  _campaignWin() {
    const s = SB.OpponentAI ? SB.OpponentAI.stats() : { moves: 0, epochs: 0 };
    this._setSprite("ko");
    this.overlay.innerHTML =
      `🏆 Champion!<div class="sub">You beat all ${this.MAX_LEVEL} levels — even after the AI trained on <b>${s.moves}</b> of your moves (${s.epochs} epochs).</div>`;
    this._campaignButtons();
    this.overlay.classList.add("show");
    if (this.pose) this.pose.stop();
    if (SB.afterMatch) setTimeout(() => SB.afterMatch({ mode: "single", won: true, kos: 1, score: 100 + s.epochs }), 400);
    SB.Coach.say("win", "beat all AI levels", (t) => { const d = document.createElement("div"); d.className = "sub"; d.textContent = t; this.overlay.insertBefore(d, this.overlay.querySelector(".end-actions")); });
  },

  _levelLost() {
    this._setSprite("attack");
    this.overlay.innerHTML =
      `💥 Knocked Down — Level ${this.level}<div class="sub">The trained AI took this one. Retry the level or step back.</div>`;
    const row = document.createElement("div");
    row.className = "end-actions";
    const retry = document.createElement("button");
    retry.className = "btn btn-primary"; retry.textContent = "🔁 Retry Level " + this.level;
    retry.onclick = () => { this.overlay.classList.remove("show"); this._reactBusy = false; this._startLevel(this.level); };
    const menu = document.createElement("button");
    menu.className = "btn btn-ghost"; menu.textContent = "← Back to Menu";
    menu.onclick = () => SB.goMenu();
    row.appendChild(retry); row.appendChild(menu);
    this.overlay.appendChild(row);
    this.overlay.classList.add("show");
    if (!this._lossRecorded && SB.afterMatch) {
      this._lossRecorded = true;
      const s = SB.OpponentAI ? SB.OpponentAI.stats() : { epochs: 0 };
      setTimeout(() => SB.afterMatch({ mode: "single", won: false, kos: 0, score: (this.level - 1) * 25 }), 400);
    }
  },

  _campaignButtons() {
    const row = document.createElement("div");
    row.className = "end-actions";
    const again = document.createElement("button");
    again.className = "btn btn-primary"; again.textContent = "🔁 Play Again";
    again.onclick = () => { this.stop(); this.start(); };
    const menu = document.createElement("button");
    menu.className = "btn btn-ghost"; menu.textContent = "← Back to Menu";
    menu.onclick = () => SB.goMenu();
    row.appendChild(again); row.appendChild(menu);
    this.overlay.appendChild(row);
  },

  _renderHP() {
    document.getElementById("single-hp-you").style.width = this.hpYou + "%";
    document.getElementById("single-hp-ai").style.width = (100 * this.hpAI / (this.hpAImax || 100)) + "%";
  },
  _renderTime() { document.getElementById("single-timer").textContent = Math.max(0, this.timeLeft); },
  _renderLevel() { if (this.levelEl) this.levelEl.textContent = "Level " + this.level + " / " + this.MAX_LEVEL; },

  _renderAIChip(pred) {
    if (!this.aiEl) return;
    if (pred && pred.prob != null) {
      this.aiEl.textContent = `🧠 reads: ${SB.MOVE_LABEL[pred.move] || pred.move} ${Math.round(pred.prob * 100)}%`;
      this.aiEl.classList.add("live");
    } else {
      const s = SB.OpponentAI ? SB.OpponentAI.stats() : null;
      this.aiEl.textContent = s && s.epochs ? `🧠 AI: ${s.moves} moves · ${s.epochs} epochs` : "🧠 AI: learning your style…";
      this.aiEl.classList.remove("live");
    }
  },

  _float(text, color, xr, yr) {
    const el = document.createElement("div");
    el.className = "hit-float"; el.textContent = text; el.style.color = color;
    el.style.left = (xr * 100) + "%"; el.style.top = (yr * 100) + "%";
    this.stage.appendChild(el);
    setTimeout(() => el.remove(), 800);
  },
  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

  stop() {
    this.active = false;
    this._runId++;            // signal any running async loops/timeouts to bail
    clearInterval(this.tickId);
    clearTimeout(this._recoverT);
    if (this.pose) this.pose.stop();
    this.pose = null;
  },
};
