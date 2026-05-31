/*
 * main.js — app shell: screen routing, the API-key gate, menu wiring, and
 * deep-linking into a multiplayer room when the URL has ?room=CODE (so a
 * forwarded WhatsApp link drops you straight into the match lobby).
 */
(function () {
  const screens = {
    apikey: document.getElementById("screen-apikey"),
    menu: document.getElementById("screen-menu"),
    training: document.getElementById("screen-training"),
    single: document.getElementById("screen-single"),
    multiplayer: document.getElementById("screen-multiplayer"),
  };

  let current = "apikey";

  function show(name) {
    // tear down whatever was running
    if (current === "training") SB.Training.stop();
    if (current === "single") SB.Single.stop();
    if (current === "multiplayer") SB.MP.stop();

    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
    current = name;
  }

  // Exposed so game/multiplayer end screens can return to the menu.
  SB.goMenu = () => show("menu");

  // Background fight music + its toggle.
  if (SB.Music) SB.Music.init();

  // Safety net: always release the camera if the page is closed or hidden.
  window.addEventListener("pagehide", () => {
    try { SB.Training.stop(); } catch (e) {}
    try { SB.Single.stop(); } catch (e) {}
    try { SB.MP.stop(); } catch (e) {}
  });

  // ---------- API key gate ----------
  const keyInput = document.getElementById("apikey-input");
  const skip = document.getElementById("apikey-skip");
  const errEl = document.getElementById("apikey-error");

  function enterApp() {
    // If a room link was forwarded, jump straight to multiplayer lobby+join.
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    if (room) {
      show("multiplayer");
      SB.MP.initLobby();
      SB.MP.joinMatch(room);
    } else {
      show("menu");
    }
  }

  document.getElementById("apikey-save").onclick = () => {
    errEl.textContent = "";
    if (skip.checked) {
      SB.config.setKey("");
      enterApp();
      return;
    }
    const k = keyInput.value.trim();
    if (!k || !k.startsWith("sk-")) {
      errEl.textContent = "Enter a valid OpenAI key (starts with sk-), or tick Skip.";
      return;
    }
    SB.config.setKey(k);
    enterApp();
  };

  // ---------- menu ----------
  document.querySelectorAll(".mode-card[data-mode]").forEach((card) => {
    card.onclick = () => {
      const mode = card.dataset.mode;
      if (mode === "training") { show("training"); SB.Training.start(); }
      else if (mode === "single") { show("single"); SB.Single.start(); }
      else if (mode === "multiplayer") { show("multiplayer"); SB.MP.initLobby(); }
    };
  });

  document.getElementById("btn-settings").onclick = () => {
    keyInput.value = SB.config.getKey();
    show("apikey");
  };

  // back buttons
  document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => show("menu")));

  // ---------- boot ----------
  const params = new URLSearchParams(location.search);
  if (params.get("room")) {
    // Invited guest: skip the API-key screen entirely and go straight into the
    // match. The inviter's key powers the coach for both players.
    enterApp();
  } else if (SB.config.hasKey()) {
    keyInput.value = SB.config.getKey();
  }
})();
