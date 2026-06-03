/*
 * config.js — small global game config.
 * No API keys, no accounts: Fight Club is fully free and on-device.
 */
window.SB = window.SB || {};

SB.config = {};

// The compact move vocabulary the whole game understands.
SB.MOVES = ["jab", "cross", "hook", "slip", "block"];

SB.MOVE_LABEL = {
  jab: "Jab",
  cross: "Cross",
  hook: "Hook",
  slip: "Slip",
  block: "Block",
};
