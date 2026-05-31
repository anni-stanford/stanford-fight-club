/*
 * db.js — the shared records database.
 *
 * Every fighter profile (record, belt, rating) is written here so the
 * leaderboard always reflects who has what record, across all devices and
 * players. It uses a Firebase Realtime Database over its plain REST endpoint
 * (no SDK, no build step) — set DB_URL below to your database and the global
 * leaderboard turns on instantly. Until then it falls back to this device's
 * local records so the app still works.
 *
 * ── ONE-TIME SETUP (≈5 min, free, no card) ──────────────────────────────
 *  1. https://console.firebase.google.com → Add project (any name).
 *  2. Build → Realtime Database → Create database → Start in TEST mode.
 *  3. Copy the database URL it shows, e.g.
 *     https://fightclub-1234-default-rtdb.firebaseio.com
 *  4. Paste it into DB_URL below, commit & push. Done — global leaderboard live.
 * ─────────────────────────────────────────────────────────────────────────
 */
window.SB = window.SB || {};

SB.DB = {
  // ⬇️  Paste your Firebase Realtime Database URL here to enable the GLOBAL leaderboard.
  DB_URL: "",

  isCloud() { return !!this.DB_URL; },

  // Save/merge a fighter profile to the shared database (fire-and-forget).
  saveProfile(p) {
    if (!this.isCloud() || !p || !p.id) return;
    fetch(`${this.DB_URL}/profiles/${p.id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }).catch(() => {});
  },

  // Fetch the full leaderboard (sorted by rating). Falls back to local records.
  fetchLeaderboard(cb) {
    if (!this.isCloud()) { cb(SB.Profile.localLeaderboard(), false); return; }
    fetch(`${this.DB_URL}/profiles.json`)
      .then((r) => r.json())
      .then((obj) => {
        const arr = obj ? Object.values(obj).filter((x) => x && x.id) : [];
        arr.sort((a, b) => SB.Profile.rating(b) - SB.Profile.rating(a));
        cb(arr, true);
      })
      .catch(() => cb(SB.Profile.localLeaderboard(), false));
  },
};
