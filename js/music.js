/*
 * music.js — background fight music.
 *
 * Plays a looping audio track (assets/theme.mp3, supplied by the project owner)
 * with a small 🔊/🔇 toggle. Music is OFF by default and NEVER autoplays — it
 * only plays once the user explicitly turns it on with the button.
 */
window.SB = window.SB || {};

SB.Music = {
  KEY: "shadowbox_music",
  TRACK: "assets/theme.mp3",
  audio: null,

  // OFF unless the user has explicitly enabled it.
  enabled() { return localStorage.getItem(this.KEY) === "on"; },

  init() {
    this.btn = document.getElementById("music-toggle");
    this.audio = new Audio(this.TRACK);
    this.audio.loop = true;
    this.audio.volume = 0.55;
    this.audio.preload = "none";

    if (this.btn) this.btn.addEventListener("click", () => this.toggle());
    this._render();

    // Only start (if previously enabled) after a user gesture.
    const startOnGesture = () => {
      if (this.enabled()) this.play();
      window.removeEventListener("pointerdown", startOnGesture);
    };
    window.addEventListener("pointerdown", startOnGesture, { once: true });
  },

  play() {
    if (!this.audio) return;
    const p = this.audio.play();
    if (p && p.catch) p.catch(() => {});
    this._render();
  },

  stop() {
    if (!this.audio) return;
    this.audio.pause();
    this._render();
  },

  toggle() {
    const turnOn = !this.enabled();
    localStorage.setItem(this.KEY, turnOn ? "on" : "off");
    if (turnOn) this.play();
    else this.stop();
    this._render();
  },

  _render() { if (this.btn) this.btn.textContent = this.enabled() ? "🔊" : "🔇"; },
};
