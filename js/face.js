/*
 * face.js — capture the player's face from the webcam and save it to their
 * profile. The face is auto-detected with MoveNet's face keypoints (nose, eyes,
 * ears), cropped to a square, mirrored to match the on-screen preview, and
 * stored as a small JPEG data URL. In multiplayer this image is shown as the
 * opponent's head — and gets progressively beaten up as their HP drops.
 *
 * Everything stays on-device: the photo lives only in localStorage and is sent
 * peer-to-peer (via the match relay) only to the people you're fighting.
 */
window.SB = window.SB || {};

SB.Face = {
  detector: null,
  stream: null,
  running: false,
  _onDone: null,
  _holdFrames: 0,
  _captured: null,

  init() {
    this.modal = document.getElementById("facecap");
    this.video = document.getElementById("facecap-video");
    this.canvas = document.getElementById("facecap-canvas");
    this.preview = document.getElementById("facecap-preview");
    this.ring = document.getElementById("facecap-ring");
    this.hint = document.getElementById("facecap-hint");
    this.btnShoot = document.getElementById("facecap-shoot");
    this.btnUse = document.getElementById("facecap-use");
    this.btnRetake = document.getElementById("facecap-retake");
    this.btnSkip = document.getElementById("facecap-skip");
    if (!this.modal) return;

    this.btnShoot.onclick = () => this._capture();
    this.btnUse.onclick = () => { const c = this._captured; this._finish(c); };
    this.btnRetake.onclick = () => this._liveMode();
    this.btnSkip.onclick = () => this._finish(null);
  },

  // open(cb) — cb(dataUrlOrNull). Optional title for first-time vs retake.
  async open(cb, title) {
    if (!this.modal) this.init();
    this._onDone = cb || null;
    this._captured = null;
    document.getElementById("facecap-title").textContent = title || "Add your fighter face";
    this.modal.hidden = false;
    this._liveMode();
    this.hint.textContent = "Starting camera…";

    try {
      await this._startCamera();
    } catch (e) {
      this.hint.textContent = "Couldn't open the camera. You can Skip and use an emoji instead.";
      return;
    }
    try { await this._ensureDetector(); } catch (e) {}
    this.running = true;
    this._holdFrames = 0;
    this._loop();
  },

  _liveMode() {
    this._captured = null;
    this.video.hidden = false;
    this.ring.hidden = false;
    this.preview.hidden = true;
    this.btnShoot.hidden = false;
    this.btnUse.hidden = true;
    this.btnRetake.hidden = true;
    this.ring.classList.remove("locked");
    this.hint.textContent = "Center your face in the ring…";
    if (this.stream && !this.running) { this.running = true; this._loop(); }
  },

  async _startCamera() {
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("webkit-playsinline", "");
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } }, audio: false });
    } catch (e) {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    this.video.srcObject = this.stream;
    await new Promise((res) => { if (this.video.readyState >= 2) return res(); this.video.onloadedmetadata = () => res(); setTimeout(res, 1500); });
    try { await this.video.play(); } catch (e) {}
  },

  async _ensureDetector() {
    if (this.detector) return;
    try { await tf.setBackend("webgl"); await tf.ready(); }
    catch (e) { try { await tf.setBackend("cpu"); await tf.ready(); } catch (e2) {} }
    this.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    );
  },

  async _loop() {
    if (!this.running) return;
    let box = null;
    if (this.detector) {
      try {
        const poses = await this.detector.estimatePoses(this.video, { flipHorizontal: false });
        if (poses && poses[0]) box = this._faceBox(poses[0].keypoints);
      } catch (e) {}
    }
    if (box) {
      this._lastBox = box;
      this._holdFrames++;
      this.ring.classList.add("locked");
      if (this._holdFrames > 14) { this.hint.textContent = "Got it!"; this._capture(); return; }
      else this.hint.textContent = "Hold still…";
    } else {
      this._holdFrames = Math.max(0, this._holdFrames - 1);
      this.ring.classList.remove("locked");
      if (this.detector) this.hint.textContent = "Center your face in the ring…";
      else this.hint.textContent = "Tap Capture when you're ready.";
    }
    requestAnimationFrame(() => this._loop());
  },

  _faceBox(kp) {
    const by = {};
    for (const k of kp) by[k.name] = k;
    const pts = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"].map((n) => by[n]).filter((p) => p && p.score > 0.3);
    if (pts.length < 2) return null;
    const nose = by.nose && by.nose.score > 0.3 ? by.nose : pts[0];
    let cx = 0, cy = 0;
    pts.forEach((p) => { cx += p.x; cy += p.y; });
    cx /= pts.length; cy /= pts.length;
    let span = 60;
    if (by.left_ear && by.right_ear && by.left_ear.score > 0.3 && by.right_ear.score > 0.3) {
      span = Math.hypot(by.left_ear.x - by.right_ear.x, by.left_ear.y - by.right_ear.y);
    } else if (by.left_eye && by.right_eye) {
      span = Math.hypot(by.left_eye.x - by.right_eye.x, by.left_eye.y - by.right_eye.y) * 2.4;
    }
    const half = Math.max(50, span * 1.5);
    return { cx: nose.x || cx, cy: (nose.y || cy) - half * 0.12, half };
  },

  // Crop + mirror a square face from any <video> using a face box. Returns a JPEG data URL.
  _cropFace(video, box, out) {
    out = out || 256;
    const vw = video.videoWidth || 480, vh = video.videoHeight || 480;
    let bs = box.half * 2;
    if (bs > Math.min(vw, vh)) bs = Math.min(vw, vh);
    let bx = box.cx - bs / 2, by = box.cy - bs / 2;
    bx = Math.max(0, Math.min(bx, vw - bs));
    by = Math.max(0, Math.min(by, vh - bs));
    const cv = this._tmp || (this._tmp = document.createElement("canvas"));
    cv.width = out; cv.height = out;
    const c = cv.getContext("2d");
    c.save();
    c.translate(out, 0); c.scale(-1, 1); // mirror to match the on-screen (mirrored) view
    c.drawImage(video, bx, by, bs, bs, 0, 0, out, out);
    c.restore();
    try { return cv.toDataURL("image/jpeg", 0.72); } catch (e) { return null; }
  },

  // Grab a face from a live video given current MoveNet keypoints (array OR byName map).
  // Returns a data URL, or null if no confident face is visible. Used to auto-snap a
  // player's face during a match so opponents always see a real photo (not an emoji).
  grabFace(video, keypoints) {
    if (!video || !video.videoWidth) return null;
    const arr = keypoints && !Array.isArray(keypoints) ? Object.values(keypoints) : (keypoints || []);
    const box = this._faceBox(arr);
    if (!box) return null;
    return this._cropFace(video, box, 224);
  },

  _capture() {
    const vw = this.video.videoWidth || 480, vh = this.video.videoHeight || 480;
    const box = this._lastBox || { cx: vw / 2, cy: vh / 2, half: Math.min(vw, vh) * 0.42 };
    const url = this._cropFace(this.video, box, 256);
    if (!url) { this.hint.textContent = "Capture failed — try again."; this._liveMode(); return; }

    this._captured = url;
    this.running = false;
    this.preview.src = url;
    this.preview.hidden = false;
    this.video.hidden = true;
    this.ring.hidden = true;
    this.btnShoot.hidden = true;
    this.btnUse.hidden = false;
    this.btnRetake.hidden = false;
    this.hint.textContent = "Looking good?";
  },

  _finish(dataUrl) {
    this._stopCamera();
    this.modal.hidden = true;
    const cb = this._onDone; this._onDone = null;
    if (cb) cb(dataUrl);
  },

  _stopCamera() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  },
};
