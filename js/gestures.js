/*
 * gestures.js — turns a stream of pose keypoints into boxing moves.
 *
 * Tuned for a FRONT-FACING player (you square up to the camera). The hard part
 * of single-webcam boxing is that a straight punch travels toward the camera
 * (in depth), so the wrist barely moves in 2D x. The reliable 2D signal we DO
 * see head-on is: the gloved hand thrusts UP from the guard to ~head height
 * with a sharp velocity spike, the forearm straightens (wrist gets farther
 * from the elbow), then it snaps back. We detect on that thrust.
 *
 *   jab/cross : fast straight thrust of one hand up to head height
 *               (lead hand = jab, rear hand = cross)
 *   hook      : hand swings across at head height (dominant horizontal motion)
 *   slip      : head shifts left/right off the shoulder midline
 *   block     : both hands raised near the face (guard up)
 *
 * Depth-free heuristics on smoothed velocity + arm extension, with per-move
 * cooldowns. Coordinates are video pixels (mirrored view).
 *
 * Emits SB.Gestures.onMove(moveName, meta) at most once per cooldown window.
 */
window.SB = window.SB || {};

SB.Gestures = class {
  constructor() {
    this.onMove = null;
    this.cooldownMs = 380;
    this.lastMoveAt = {};
    this.guardUpSince = 0;
    this.shoulderWidth = 120;
    // short history per hand for smoothed velocity + extension delta
    this.hist = { left: [], right: [] };
    this.HIST = 4;
  }

  feed(kp) {
    const t = performance.now();
    const need = ["left_wrist", "right_wrist", "left_shoulder", "right_shoulder", "nose"];
    for (const n of need) if (!kp[n] || kp[n].score < 0.2) return;

    const ls = kp.left_shoulder, rs = kp.right_shoulder, nose = kp.nose;
    const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y) || this.shoulderWidth;
    this.shoulderWidth = this.shoulderWidth * 0.85 + sw * 0.15;
    const SW = this.shoulderWidth;
    const midX = (ls.x + rs.x) / 2;
    const midY = (ls.y + rs.y) / 2;

    // ---- BLOCK: both wrists raised near the face (guard up) ----
    const lw = kp.left_wrist, rw = kp.right_wrist;
    const lwUp = lw.y < midY + SW * 0.35;
    const rwUp = rw.y < midY + SW * 0.35;
    const narrow = Math.abs(lw.x - rw.x) < SW * 1.4;
    if (lwUp && rwUp && narrow) {
      if (!this.guardUpSince) this.guardUpSince = t;
      if (t - this.guardUpSince > 160) this._emit("block", t, { hold: true });
    } else {
      this.guardUpSince = 0;
    }

    // ---- SLIP: head shifts laterally off the shoulder midline ----
    const headOffset = (nose.x - midX) / SW;
    if (Math.abs(headOffset) > 0.45) {
      this._emit("slip", t, { dir: headOffset > 0 ? "right" : "left" });
    }

    // ---- PUNCHES: analyse each hand's recent trajectory ----
    for (const side of ["left", "right"]) {
      const w = kp[side + "_wrist"];
      const sh = kp[side + "_shoulder"];
      const el = kp[side + "_elbow"];
      if (!w || w.score < 0.22 || !sh) continue;

      const forearm = el && el.score > 0.2 ? Math.hypot(w.x - el.x, w.y - el.y) / SW : 0;
      const reach = Math.hypot(w.x - sh.x, w.y - sh.y) / SW;

      const h = this.hist[side];
      h.push({ x: w.x, y: w.y, forearm, reach, t });
      if (h.length > this.HIST) h.shift();
      if (h.length < this.HIST) continue;

      const first = h[0], last = h[h.length - 1];
      const dt = Math.max(16, last.t - first.t);
      const vx = (last.x - first.x) / dt;       // px/ms over the window
      const vy = (last.y - first.y) / dt;
      const speed = Math.hypot(vx, vy);

      // Three independent punch signals, so ANY common punch fires:
      //  1) lateral/upward 2D travel  (side punches, hooks)
      //  2) forearm foreshortening    (jab/cross straight AT the camera)
      //  3) reach change              (arm shooting out from the guard)
      let maxF = first.forearm, minF = first.forearm, maxR = first.reach, minR = first.reach;
      for (const p of h) { maxF = Math.max(maxF, p.forearm); minF = Math.min(minF, p.forearm); maxR = Math.max(maxR, p.reach); minR = Math.min(minR, p.reach); }
      const forearmSwing = maxF - minF;   // foreshortening OR extension
      const reachSwing = maxR - minR;

      const atHeadHeight = w.y < midY + SW * 0.5;   // hand is up around guard/head level
      const punch = (speed > 0.35) || (forearmSwing > 0.18) || (reachSwing > 0.2);

      if (punch && atHeadHeight) {
        const horizontal = Math.abs(vx) > Math.abs(vy) * 1.2 && Math.abs(last.x - midX) > SW * 0.4;
        if (horizontal && speed > 0.4) {
          this._emit("hook", t, { side });
        } else {
          const lead = this._leadSide(kp, SW, midX);
          this._emit(side === lead ? "jab" : "cross", t, { side });
        }
        h.length = 0; // reset so we don't double-count the same thrust
      }
    }
  }

  _leadSide(kp, SW, midX) {
    // Whichever hand is held nearer the centre line is treated as the lead.
    const lw = kp.left_wrist, rw = kp.right_wrist;
    const ld = Math.abs(lw.x - midX), rd = Math.abs(rw.x - midX);
    return ld <= rd ? "left" : "right";
  }

  _emit(move, t, meta) {
    if (t - (this.lastMoveAt[move] || 0) < this.cooldownMs) return;
    this.lastMoveAt[move] = t;
    if (this.onMove) this.onMove(move, meta || {});
  }

  reset() {
    this.lastMoveAt = {}; this.guardUpSince = 0;
    this.hist = { left: [], right: [] };
  }
};
