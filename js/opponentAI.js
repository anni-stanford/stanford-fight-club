/*
 * opponentAI.js — a REAL neural network that learns YOUR fighting style,
 * written in PLAIN JavaScript and trained 100% on the CPU. No GPU, no WebGL,
 * no TensorFlow, no server — so it runs anywhere, even a weak phone.
 *
 * Why hand-rolled? The model is tiny, so we don't need a heavy ML library or a
 * graphics card. A few small matrix multiplies + backpropagation in JavaScript
 * train it in well under a second. This guarantees "trains on your device's CPU"
 * is literally true on every device.
 *
 *   • Data:   every move you make (jab/cross/hook/slip/block) is recorded as a
 *             sequence. Training samples = "your last K moves -> your next move".
 *   • Model:  15 -> 24 (ReLU) -> 16 (ReLU) -> 5 (softmax), ~870 weights.
 *   • Train:  after each of the 4 levels we run gradient descent on ALL your
 *             moves so far, warm-started and for MORE epochs each level
 *             (16 -> 42 -> 78 cumulative), so it gets more "trained on you".
 *   • Use:    in-fight the opponent predicts your next move and pre-guards it;
 *             higher levels trust the prediction more.
 *
 * Weights + your move history persist per fighter in localStorage, so returning
 * players face an even-more-trained opponent. Everything stays on your device.
 */
window.SB = window.SB || {};

SB.OpponentAI = {
  MOVES: ["jab", "cross", "hook", "slip", "block"],
  N: 5,
  K: 3,           // how many recent moves we look at to predict the next
  H1: 24, H2: 16, // hidden layer sizes
  IN: 15,         // K * N
  lr: 0.12,       // learning rate (SGD)

  W1: null, b1: null, W2: null, b2: null, W3: null, b3: null,
  moves: [], _recent: [],
  totalEpochs: 0, trainedLevels: 0, lastLoss: 0, lastAcc: 0,
  profileId: "guest", usingNN: true,

  async init(profileId) {
    this.profileId = profileId || "guest";
    this._recent = [];
    if (!this._load()) this._initWeights();
    this.usingNN = true; // always a real (pure-JS) neural net
    return this;
  },

  // ---------- model params ----------
  _rand(n, fanIn, fanOut) {
    const r = Math.sqrt(6 / (fanIn + fanOut));   // Xavier/Glorot init
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * r;
    return a;
  },
  _zeros(n) { return new Float64Array(n); },

  _initWeights() {
    this.W1 = this._rand(this.IN * this.H1, this.IN, this.H1); this.b1 = this._zeros(this.H1);
    this.W2 = this._rand(this.H1 * this.H2, this.H1, this.H2); this.b2 = this._zeros(this.H2);
    this.W3 = this._rand(this.H2 * this.N, this.H2, this.N);   this.b3 = this._zeros(this.N);
    this.totalEpochs = 0; this.trainedLevels = 0;
  },

  // ---------- data ----------
  record(move) {
    const idx = this.MOVES.indexOf(move);
    if (idx < 0) return;
    this.moves.push(idx);
    if (this.moves.length > 2000) this.moves = this.moves.slice(-2000);
    this._recent.push(idx);
    if (this._recent.length > this.K) this._recent.shift();
  },

  _oneHotSeq(seq) {
    const v = new Float64Array(this.IN);
    const start = this.K - seq.length;
    for (let i = 0; i < seq.length; i++) {
      const idx = seq[i];
      if (idx >= 0) v[(start + i) * this.N + idx] = 1;
    }
    return v;
  },

  // ---------- forward pass (pure JS) ----------
  _forward(x) {
    const { W1, b1, W2, b2, W3, b3, IN, H1, H2, N } = this;
    const z1 = new Float64Array(H1), a1 = new Float64Array(H1);
    for (let j = 0; j < H1; j++) {
      let s = b1[j];
      for (let i = 0; i < IN; i++) if (x[i]) s += x[i] * W1[i * H1 + j];
      z1[j] = s; a1[j] = s > 0 ? s : 0; // ReLU
    }
    const z2 = new Float64Array(H2), a2 = new Float64Array(H2);
    for (let k = 0; k < H2; k++) {
      let s = b2[k];
      for (let j = 0; j < H1; j++) s += a1[j] * W2[j * H2 + k];
      z2[k] = s; a2[k] = s > 0 ? s : 0; // ReLU
    }
    const z3 = new Float64Array(N);
    let mx = -Infinity;
    for (let m = 0; m < N; m++) {
      let s = b3[m];
      for (let k = 0; k < H2; k++) s += a2[k] * W3[k * N + m];
      z3[m] = s; if (s > mx) mx = s;
    }
    const p = new Float64Array(N); let sum = 0;
    for (let m = 0; m < N; m++) { p[m] = Math.exp(z3[m] - mx); sum += p[m]; }
    for (let m = 0; m < N; m++) p[m] /= sum;
    return { z1, a1, z2, a2, p };
  },

  // Predict the player's next move from their recent pattern.
  predict() {
    if (!this.W1 || this._recent.length === 0) return null;
    const { p } = this._forward(this._oneHotSeq(this._recent.slice(-this.K)));
    let best = 0;
    for (let m = 1; m < this.N; m++) if (p[m] > p[best]) best = m;
    return { idx: best, move: this.MOVES[best], prob: p[best] };
  },

  // ---------- training (backprop + SGD, pure JS, CPU only) ----------
  _samples() {
    const xs = [], ys = [];
    for (let i = this.K; i < this.moves.length; i++) {
      xs.push(this._oneHotSeq(this.moves.slice(i - this.K, i)));
      ys.push(this.moves[i]);
    }
    return { xs, ys };
  },

  // Called AFTER finishing `level`; trains a stronger brain for the next level.
  async trainForLevel(level, onProgress) {
    const epochs = 16 + (level - 1) * 10; // L1->16, L2->26, L3->36 ...
    const { xs, ys } = this._samples();
    if (!this.W1) this._initWeights();
    if (xs.length < 4) {
      this.trainedLevels = Math.max(this.trainedLevels, level);
      this.totalEpochs += Math.round(epochs * 0.3);
      this._save();
      if (onProgress) onProgress(1, { skipped: true });
      return this.stats();
    }

    const { IN, H1, H2, N, lr } = this;
    const order = xs.map((_, i) => i);

    for (let ep = 0; ep < epochs; ep++) {
      // shuffle
      for (let i = order.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
      let loss = 0, correct = 0;

      for (const si of order) {
        const x = xs[si], y = ys[si];
        const { z1, a1, z2, a2, p } = this._forward(x);

        // prediction bookkeeping
        let best = 0; for (let m = 1; m < N; m++) if (p[m] > p[best]) best = m;
        if (best === y) correct++;
        loss += -Math.log(Math.max(1e-9, p[y]));

        // output grad: dz3 = p - onehot(y)
        const dz3 = new Float64Array(N);
        for (let m = 0; m < N; m++) dz3[m] = p[m] - (m === y ? 1 : 0);

        // grads into layer 2 (da2 -> dz2)
        const dz2 = new Float64Array(H2);
        for (let k = 0; k < H2; k++) {
          let g = 0;
          for (let m = 0; m < N; m++) g += this.W3[k * N + m] * dz3[m];
          dz2[k] = z2[k] > 0 ? g : 0; // ReLU'
        }
        // grads into layer 1 (da1 -> dz1)
        const dz1 = new Float64Array(H1);
        for (let j = 0; j < H1; j++) {
          let g = 0;
          for (let k = 0; k < H2; k++) g += this.W2[j * H2 + k] * dz2[k];
          dz1[j] = z1[j] > 0 ? g : 0;
        }

        // SGD updates (W3,b3)
        for (let k = 0; k < H2; k++) {
          const ak = a2[k]; const base = k * N;
          for (let m = 0; m < N; m++) this.W3[base + m] -= lr * ak * dz3[m];
        }
        for (let m = 0; m < N; m++) this.b3[m] -= lr * dz3[m];
        // (W2,b2)
        for (let j = 0; j < H1; j++) {
          const aj = a1[j]; const base = j * H2;
          for (let k = 0; k < H2; k++) this.W2[base + k] -= lr * aj * dz2[k];
        }
        for (let k = 0; k < H2; k++) this.b2[k] -= lr * dz2[k];
        // (W1,b1) — x is sparse (mostly zeros) so skip zero inputs
        for (let i = 0; i < IN; i++) {
          if (!x[i]) continue;
          const base = i * H1;
          for (let j = 0; j < H1; j++) this.W1[base + j] -= lr * x[i] * dz1[j];
        }
        for (let j = 0; j < H1; j++) this.b1[j] -= lr * dz1[j];
      }

      this.lastLoss = loss / xs.length;
      this.lastAcc = correct / xs.length;
      if (onProgress) onProgress((ep + 1) / epochs, { loss: this.lastLoss, acc: this.lastAcc });
      // yield to the UI thread occasionally so the page stays responsive
      if ((ep & 7) === 7) await new Promise((r) => setTimeout(r, 0));
    }

    this.totalEpochs += epochs;
    this.trainedLevels = Math.max(this.trainedLevels, level);
    this._save();
    return this.stats();
  },

  stats() {
    return { moves: this.moves.length, epochs: this.totalEpochs, levels: this.trainedLevels, acc: this.lastAcc || 0, nn: true };
  },

  // ---------- persistence (localStorage, tiny JSON) ----------
  _key() { return "fc_brain_" + this.profileId; },
  _save() {
    try {
      const w = (a) => Array.from(a, (v) => +v.toFixed(5));
      localStorage.setItem(this._key(), JSON.stringify({
        v: 1, moves: this.moves, totalEpochs: this.totalEpochs, trainedLevels: this.trainedLevels,
        W1: w(this.W1), b1: w(this.b1), W2: w(this.W2), b2: w(this.b2), W3: w(this.W3), b3: w(this.b3),
      }));
    } catch (e) {}
  },
  _load() {
    try {
      const d = JSON.parse(localStorage.getItem(this._key()) || "null");
      if (!d || !d.W1) { this.moves = (d && d.moves) || []; return false; }
      this.moves = d.moves || [];
      this.totalEpochs = d.totalEpochs || 0;
      this.trainedLevels = d.trainedLevels || 0;
      this.W1 = Float64Array.from(d.W1); this.b1 = Float64Array.from(d.b1);
      this.W2 = Float64Array.from(d.W2); this.b2 = Float64Array.from(d.b2);
      this.W3 = Float64Array.from(d.W3); this.b3 = Float64Array.from(d.b3);
      return true;
    } catch (e) { return false; }
  },

  async reset() {
    this.moves = []; this._recent = [];
    this._initWeights();
    try { localStorage.removeItem(this._key()); } catch (e) {}
  },
};
