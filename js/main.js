/*
 * main.js — app shell: screen routing, the API-key gate, menu wiring, the
 * fighter profile / dashboard / leaderboard, frictionless onboarding, the
 * viral post-match share card, and deep-linking (multiplayer ?room= and
 * challenge ?challenge= links).
 */
(function () {
  const screens = {
    menu: document.getElementById("screen-menu"),
    training: document.getElementById("screen-training"),
    single: document.getElementById("screen-single"),
    multiplayer: document.getElementById("screen-multiplayer"),
    dashboard: document.getElementById("screen-dashboard"),
  };

  let current = "menu";
  let pendingResult = null; // a finished match awaiting a freshly-created profile

  function show(name) {
    if (current === "training") SB.Training.stop();
    if (current === "single") SB.Single.stop();
    if (current === "multiplayer") SB.MP.stop();

    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
    current = name;

    if (name === "menu") renderChip();
    if (name === "dashboard") renderDashboard();
  }

  SB.goMenu = () => show("menu");
  if (SB.Music) SB.Music.init();
  if (SB.Face) SB.Face.init();
  SB.Profile.load();

  window.addEventListener("pagehide", () => {
    try { SB.Training.stop(); } catch (e) {}
    try { SB.Single.stop(); } catch (e) {}
    try { SB.MP.stop(); } catch (e) {}
  });

  // ---------- profile chip ----------
  const chip = document.getElementById("profile-chip");
  function renderChip() {
    if (!SB.Profile.exists()) { chip.hidden = true; return; }
    const p = SB.Profile.current;
    chip.hidden = false;
    document.getElementById("pc-av").textContent = p.avatar;
    document.getElementById("pc-name").textContent = p.name;
    document.getElementById("pc-belt").textContent = SB.Profile.belt(p).name;
    document.getElementById("pc-rating").textContent = SB.Profile.rating(p);
  }
  chip.onclick = () => show("dashboard");

  // ---------- dashboard ----------
  function renderDashboard() {
    const p = SB.Profile.current;
    if (!p) { openOnboard(false); return; }
    document.getElementById("dash-av").textContent = p.avatar;
    document.getElementById("dash-name").textContent = p.name;
    document.getElementById("dash-belt").textContent = SB.Profile.belt(p).name;
    document.getElementById("st-wins").textContent = p.wins || 0;
    document.getElementById("st-losses").textContent = p.losses || 0;
    document.getElementById("st-kos").textContent = p.kos || 0;
    document.getElementById("st-streak").textContent = p.streak || 0;
    document.getElementById("st-rating").textContent = SB.Profile.rating(p);

    const list = document.getElementById("lb-list");
    list.innerHTML = '<p class="muted small">Loading…</p>';
    SB.DB.fetchLeaderboard((board, isGlobal) => {
      document.getElementById("lb-scope").textContent = isGlobal
        ? "Global rankings — every fighter, everywhere."
        : "Top fighters on this device. Add a database URL to go global.";
      list.innerHTML = "";
      if (!board.length) { list.innerHTML = '<p class="muted small">No fighters yet — win a match to appear here.</p>'; return; }
      board.slice(0, 10).forEach((f, i) => {
        const row = document.createElement("div");
        row.className = "lb-row" + (f.id === p.id ? " me" : "");
        row.innerHTML =
          `<span class="lb-rank">${i + 1}</span>
           <span class="lb-av">${f.avatar || "🥊"}</span>
           <span class="lb-name">${escapeHtml(f.name || "Fighter")}<br><span class="lb-belt">${SB.Profile.belt(f).name} · ${f.wins || 0}W ${f.losses || 0}L</span></span>
           <span class="lb-rating">${SB.Profile.rating(f)}</span>`;
        list.appendChild(row);
      });
    });
  }
  document.getElementById("dash-edit").onclick = () => openOnboard(false);
  document.getElementById("dash-challenge").onclick = () => openShare(null, true);
  document.getElementById("dash-logout").onclick = () => {
    SB.Profile.logout();
    renderChip();
    show("menu");
  };

  // ---------- onboarding ----------
  const onboard = document.getElementById("onboard");
  let selAvatar = SB.AVATARS[0];
  let selFace = null;

  function renderFaceThumb() {
    const img = document.getElementById("onboard-face-img");
    const emoji = document.getElementById("onboard-face-emoji");
    const btn = document.getElementById("onboard-face-btn");
    if (selFace) {
      img.src = selFace; img.hidden = false; emoji.hidden = true;
      btn.textContent = "🔄 Retake";
    } else {
      img.hidden = true; emoji.hidden = false;
      btn.textContent = "📸 Add face";
    }
  }
  document.getElementById("onboard-face-btn").onclick = () => {
    if (!SB.Face) return;
    SB.Face.open((dataUrl) => { if (dataUrl) selFace = dataUrl; renderFaceThumb(); }, selFace ? "Retake your face" : "Add your fighter face");
  };

  function buildAvatars() {
    const grid = document.getElementById("onboard-avatars");
    grid.innerHTML = "";
    SB.AVATARS.forEach((a) => {
      const b = document.createElement("button");
      b.textContent = a;
      if (a === selAvatar) b.classList.add("sel");
      b.onclick = () => { selAvatar = a; buildAvatars(); };
      grid.appendChild(b);
    });
  }
  function openOnboard(firstTime) {
    const p = SB.Profile.current;
    selAvatar = p ? p.avatar : SB.AVATARS[Math.floor(Math.random() * SB.AVATARS.length)];
    selFace = p ? (p.face || null) : null;
    document.getElementById("onboard-name").value = p ? p.name : SB.Profile.randomName();
    document.getElementById("onboard-title").textContent = p ? "Edit your fighter" : "Name your fighter";
    buildAvatars();
    renderFaceThumb();
    onboard.hidden = false;
  }
  document.getElementById("onboard-save").onclick = () => {
    const name = document.getElementById("onboard-name").value.trim() || SB.Profile.randomName();
    if (SB.Profile.current) SB.Profile.update({ name: name.slice(0, 18), avatar: selAvatar, face: selFace });
    else { SB.Profile.create(name, selAvatar); SB.Profile.update({ face: selFace }); }
    onboard.hidden = true;
    renderChip();
    if (pendingResult) { SB.Arena.recordResult(pendingResult); const r = pendingResult; pendingResult = null; maybeShare(r); }
    if (current === "dashboard") renderDashboard();
  };

  // ---------- share / challenge card ----------
  const sharecard = document.getElementById("sharecard");
  function openShare(result, fromDashboard) {
    const p = SB.Profile.current;
    const score = result ? result.score : (p ? p.bestScore : 0);
    if (fromDashboard) {
      document.getElementById("share-emoji").textContent = "🔥";
      document.getElementById("share-title").textContent = "Challenge your friends";
      document.getElementById("share-sub").textContent = "Send your best score and see who can beat it.";
    } else {
      const won = result && result.won;
      document.getElementById("share-emoji").textContent = won ? "🏆" : "💪";
      document.getElementById("share-title").textContent = won ? "Victory!" : "Good fight!";
      document.getElementById("share-sub").textContent = won
        ? "You're climbing the ranks — call out a friend."
        : "Shake it off and challenge a friend to try.";
    }
    document.getElementById("share-wa").href = SB.Arena.whatsappChallenge(score);
    document.getElementById("share-copy").onclick = () => {
      navigator.clipboard?.writeText(SB.Arena.challengeLink(score));
      document.getElementById("share-copy").textContent = "Copied!";
      setTimeout(() => (document.getElementById("share-copy").textContent = "Copy challenge link"), 1500);
    };
    sharecard.hidden = false;
  }
  document.getElementById("share-close").onclick = () => { sharecard.hidden = true; };

  function maybeShare(result) {
    if (result && result.mode !== "training") openShare(result, false);
  }

  // Called by game modes when a match ends.
  SB.afterMatch = (result) => {
    if (!SB.Profile.exists()) { pendingResult = result; openOnboard(true); return; }
    SB.Arena.recordResult(result);
    renderChip();
    maybeShare(result);
  };

  function enterApp() {
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    if (room) { show("multiplayer"); SB.MP.initLobby(); SB.MP.joinMatch(room); }
    else { show("menu"); showIncomingChallenge(); }
  }

  // ---------- menu ----------
  document.querySelectorAll(".mode-card[data-mode]").forEach((card) => {
    card.onclick = () => {
      const mode = card.dataset.mode;
      if (mode === "training") { show("training"); SB.Training.start(); }
      else if (mode === "single") { show("single"); SB.Single.start(); }
      else if (mode === "multiplayer") { show("multiplayer"); SB.MP.initLobby(); }
      else if (mode === "dashboard") { show("dashboard"); }
    };
  });

  document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => show("menu")));

  // Incoming challenge banner (viral loop entry point).
  function showIncomingChallenge() {
    const c = SB.Arena.incomingChallenge();
    if (!c) return;
    const tag = document.querySelector("#screen-menu .tagline");
    if (tag) tag.innerHTML = `${c.avatar} <b>${escapeHtml(c.name)}</b> challenges you to beat <b>${c.pts}</b> — win a fight to answer!`;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- boot ----------
  enterApp();
})();
