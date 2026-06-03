/*
 * coach.js — the in-game coach voice.
 *
 * Fully on-device: it picks from curated boxing-coach lines. No API key, no
 * network call, no LLM — so the game is 100% free to play and nothing ever
 * leaves the browser. Calls are lightly throttled so the bubble doesn't spam.
 */
window.SB = window.SB || {};

SB.Coach = {
  _last: 0,
  minGapMs: 3500,

  _fallback: {
    intro: ["Hands up, chin down. Let's work.", "Stay light on your feet. Here we go.", "Find your range and stay sharp.", "Eyes up — read the shot."],
    good: ["Nice and crisp!", "That's the shot!", "Beautiful timing.", "Keep that rhythm.", "Snap it back!"],
    fix: ["Get that guard back up.", "Turn the hip into it.", "Don't reach — let it snap.", "Stop telegraphing, stay loose."],
    win: ["That's the round! Clean work.", "You ran that round. Great boxing.", "Dominant. Take a breath.", "Champion stuff right there."],
    lose: ["Shake it off — reset and go again.", "Tough round. Tighten the guard next time.", "Learn from it. The round's not the war."],
  },

  pick(kind) {
    const arr = this._fallback[kind] || this._fallback.good;
    return arr[Math.floor(Math.random() * arr.length)];
  },

  // kind: intro|good|fix|win|lose.  summary is ignored (kept for call-site compatibility).  cb(text)
  say(kind, summary, cb) {
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    // Always allow result lines (win/lose/intro); throttle the in-fight chatter.
    if (kind === "good" || kind === "fix") {
      if (now - this._last < this.minGapMs) return;
    }
    this._last = now;
    if (cb) cb(this.pick(kind));
  },
};
