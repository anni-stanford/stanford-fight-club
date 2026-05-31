/*
 * config.js — small global config + OpenAI API key storage.
 * The key lives only in this browser's localStorage. It is never sent
 * anywhere except api.openai.com when the coach asks for commentary.
 */
window.SB = window.SB || {};

SB.config = {
  KEY_STORAGE: "shadowbox_openai_key",
  _sessionKey: "", // in-memory only (e.g. a host's key shared into a match); never persisted

  getKey() {
    return this._sessionKey || localStorage.getItem(this.KEY_STORAGE) || "";
  },
  setKey(k) {
    if (k) localStorage.setItem(this.KEY_STORAGE, k);
    else localStorage.removeItem(this.KEY_STORAGE);
  },
  // Used in multiplayer: the inviter's key powers the coach for both players,
  // kept only in memory on the guest's side so it's gone when they close the tab.
  setSessionKey(k) {
    this._sessionKey = k || "";
  },
  hasKey() {
    return !!this.getKey();
  },
};

// The compact move vocabulary the whole game understands.
SB.MOVES = ["jab", "cross", "hook", "slip", "block"];

SB.MOVE_LABEL = {
  jab: "Jab",
  cross: "Cross",
  hook: "Hook",
  slip: "Slip",
  block: "Block",
};
