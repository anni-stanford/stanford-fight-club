/*
 * pose.js — webcam capture + real-time pose estimation with MoveNet.
 *
 * Exposes SB.Pose, a small controller you point at a <video> and <canvas>.
 * It streams the webcam into the video, runs MoveNet every animation frame,
 * draws the skeleton onto the canvas, and hands each frame's keypoints to a
 * callback so the gesture classifier can interpret them.
 *
 * Single-webcam pose estimation is reliable for front-facing, full-body,
 * controlled-speed movement (exactly what ShadowBox asks for). We keep only
 * the keypoints we need for boxing and mirror everything so the player sees
 * themselves as in a mirror.
 */
window.SB = window.SB || {};

SB.Pose = class {
  constructor(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.detector = null;
    this.stream = null;
    this.running = false;
    this.onFrame = null; // (keypointsByName, rawPose) => void
  }

  async start(onFrame) {
    this.onFrame = onFrame;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("camera-unsupported");
    }

    // iOS Safari needs these set on the element for inline autoplay to work.
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("webkit-playsinline", "");
    this.video.setAttribute("autoplay", "");
    this.video.muted = true;
    this.video.playsInline = true;

    // 1. Camera — try ideal constraints, then fall back to bare video:true (phones).
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
    } catch (e) {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    this.video.srcObject = this.stream;

    // Wait for dimensions, then play (catch autoplay-gesture rejections on iOS).
    await new Promise((res) => {
      if (this.video.readyState >= 2) return res();
      this.video.onloadedmetadata = () => res();
      setTimeout(res, 1500);
    });
    try { await this.video.play(); } catch (e) { /* autoplay attr will handle it */ }

    // 2. Pose backend — WebGL first, fall back to CPU if a device lacks it.
    try {
      await tf.setBackend("webgl");
      await tf.ready();
    } catch (e) {
      try { await tf.setBackend("cpu"); await tf.ready(); } catch (e2) {}
    }
    this.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    );

    this.running = true;
    this._loop();
  }

  async _loop() {
    if (!this.running) return;
    const w = this.video.videoWidth || 640;
    const h = this.video.videoHeight || 480;
    if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }

    let poses = [];
    try {
      poses = await this.detector.estimatePoses(this.video, { flipHorizontal: false });
    } catch (e) { /* transient frame errors are fine */ }

    this.ctx.clearRect(0, 0, w, h);

    if (poses && poses[0]) {
      const kp = this._byName(poses[0].keypoints);
      this._draw(kp);
      if (this.onFrame) this.onFrame(kp, poses[0]);
    }

    requestAnimationFrame(() => this._loop());
  }

  _byName(keypoints) {
    const out = {};
    for (const k of keypoints) out[k.name] = k;
    return out;
  }

  _draw(kp) {
    const ctx = this.ctx;
    const links = [
      ["left_shoulder", "right_shoulder"],
      ["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"],
      ["right_shoulder", "right_elbow"], ["right_elbow", "right_wrist"],
      ["left_shoulder", "left_hip"], ["right_shoulder", "right_hip"],
      ["left_hip", "right_hip"],
      ["left_hip", "left_knee"], ["left_knee", "left_ankle"],
      ["right_hip", "right_knee"], ["right_knee", "right_ankle"],
    ];
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,138,59,0.85)";
    ctx.fillStyle = "rgba(255,59,59,0.95)";
    for (const [a, b] of links) {
      const ka = kp[a], kb = kp[b];
      if (ka && kb && ka.score > 0.3 && kb.score > 0.3) {
        ctx.beginPath(); ctx.moveTo(ka.x, ka.y); ctx.lineTo(kb.x, kb.y); ctx.stroke();
      }
    }
    for (const name in kp) {
      const k = kp[name];
      if (k.score > 0.3) { ctx.beginPath(); ctx.arc(k.x, k.y, 5, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
};
