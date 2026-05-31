/*
 * fightclub.js — fighter identity, stats, belts, leaderboard, and viral hooks.
 *
 * Design goals: ZERO friction + viral by default.
 *  - No signup wall: you play instantly. A profile is only requested AFTER your
 *    first match, as a single step (pick a name + emoji). Stored locally.
 *  - Every match auto-records to your profile and the local leaderboard.
 *  - "Belts" (rank progression) + daily streaks drive retention.
 *  - Challenge links (?challenge=...) carry a fighter + score so beating someone
 *    and sharing it pulls new players in — no backend required for the loop.
 *
 * This is the local-first foundation. A cloud layer (global leaderboard, teams,
 * tournaments) can plug into the same SB.Arena API later.
 */
window.SB = window.SB || {};

SB.AVATARS = ["🥊", "🐅", "🦁", "🐺", "🦅", "🐉", "🦈", "🐍", "⚡", "🔥", "💀", "👊", "🐻", "🦂"];

// Belt progression by total wins — visible, gamified, retention-driving.
SB.BELTS = [
  { name: "White Belt", color: "#e8e8ee", min: 0 },
  { name: "Yellow Belt", color: "#ffd23f", min: 3 },
  { name: "Orange Belt", color: "#ff8a3b", min: 8 },
  { name: "Green Belt", color: "#2bd66a", min: 15 },
  { name: "Blue Belt", color: "#3b9bff", min: 25 },
  { name: "Brown Belt", color: "#a0522d", min: 40 },
  { name: "Black Belt", color: "#1d1d1f", min: 60 },
  { name: "Champion", color: "#ff3b3b", min: 90 },
];

SB.Profile = {
  CUR: "fc_profile",
  ALL: "fc_profiles",

  current: null,

  load() {
    try { this.current = JSON.parse(localStorage.getItem(this.CUR) || "null"); } catch (e) { this.current = null; }
    return this.current;
  },

  exists() { return !!(this.current && this.current.name); },

  randomName() {
    const a = ["Iron", "Shadow", "Steel", "Thunder", "Venom", "Blitz", "Rapid", "Savage", "Phantom", "Nitro", "Crimson", "Atomic"];
    const b = ["Fist", "Hook", "Jab", "Storm", "Fang", "Bolt", "Cobra", "Hammer", "Reaper", "Striker", "Puncher", "Cross"];
    return a[Math.floor(Math.random() * a.length)] + b[Math.floor(Math.random() * b.length)];
  },

  create(name, avatar) {
    const p = {
      id: "f_" + Math.random().toString(36).slice(2, 10),
      name: (name || this.randomName()).slice(0, 18),
      avatar: avatar || SB.AVATARS[0],
      wins: 0, losses: 0, kos: 0, punches: 0,
      bestScore: 0, streak: 0, lastPlayed: null, created: Date.now(),
    };
    this.current = p;
    this._save();
    return p;
  },

  update(fields) {
    if (!this.current) return;
    Object.assign(this.current, fields);
    this._save();
  },

  _save() {
    localStorage.setItem(this.CUR, JSON.stringify(this.current));
    // mirror into the local all-profiles map (offline / fallback leaderboard)
    const all = this._all();
    all[this.current.id] = this.current;
    localStorage.setItem(this.ALL, JSON.stringify(all));
    // push to the shared database so everyone's records live in one place
    if (SB.DB) SB.DB.saveProfile(this.current);
  },

  _all() {
    try { return JSON.parse(localStorage.getItem(this.ALL) || "{}"); } catch (e) { return {}; }
  },

  rating(p) { return Math.max(0, (p.wins || 0) * 100 + (p.kos || 0) * 30 - (p.losses || 0) * 10); },

  belt(p) {
    const w = p.wins || 0;
    let b = SB.BELTS[0];
    for (const belt of SB.BELTS) if (w >= belt.min) b = belt;
    return b;
  },

  // Local-only leaderboard (used as the offline / fallback source by SB.DB).
  localLeaderboard() {
    const all = Object.values(this._all());
    all.sort((a, b) => this.rating(b) - this.rating(a));
    return all;
  },
};

SB.Arena = {
  // Record a finished match. result: { mode, won, kos, punches, score, oppName }
  recordResult(result) {
    if (!SB.Profile.current) return;
    const p = SB.Profile.current;
    const today = new Date().toDateString();

    // daily streak
    if (p.lastPlayed !== today) {
      const yest = new Date(Date.now() - 864e5).toDateString();
      p.streak = p.lastPlayed === yest ? (p.streak || 0) + 1 : 1;
      p.lastPlayed = today;
    }

    // Only competitive modes (single / multiplayer) affect win/loss.
    if (typeof result.won === "boolean") {
      if (result.won) p.wins = (p.wins || 0) + 1;
      else p.losses = (p.losses || 0) + 1;
    }
    if (result.kos) p.kos = (p.kos || 0) + result.kos;
    if (result.punches) p.punches = (p.punches || 0) + result.punches;
    if (result.score && result.score > (p.bestScore || 0)) p.bestScore = result.score;

    SB.Profile.update({});  // persists current + leaderboard mirror
    this._lastResult = result;
  },

  // ---- viral challenge links ----
  // Build a forwardable link that challenges a friend to beat your score.
  challengeLink(score) {
    const p = SB.Profile.current;
    const base = location.origin + location.pathname;
    const params = new URLSearchParams({
      challenge: p ? p.name : "A fighter",
      av: p ? p.avatar : "🥊",
      pts: String(score || (p ? p.bestScore : 0) || 0),
    });
    return base + "?" + params.toString();
  },

  whatsappChallenge(score) {
    const link = this.challengeLink(score);
    const p = SB.Profile.current;
    const msg = `I scored ${score || (p ? p.bestScore : 0)} on Fight Club 🥊 Think you can beat me? Tap to fight: ${link}`;
    return "https://wa.me/?text=" + encodeURIComponent(msg);
  },

  // Read an incoming challenge from the URL (if any).
  incomingChallenge() {
    const q = new URLSearchParams(location.search);
    if (!q.get("challenge")) return null;
    return { name: q.get("challenge"), avatar: q.get("av") || "🥊", pts: parseInt(q.get("pts") || "0", 10) };
  },
};
