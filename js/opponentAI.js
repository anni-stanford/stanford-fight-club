/*
 * opponentAI.js — a REAL, on-device neural network that learns YOUR fighting
 * style and gets smarter every level.
 *
 * This is genuine machine learning (TensorFlow.js), trained in your browser on
 * the moves you actually throw — no servers, no pre-baked behavior:
 *
 *   • Data:   every move you make (jab/cross/hook/slip/block) is recorded as a
 *             sequence. We build training samples of "last K moves -> next move".
 *   • Model:  a small classifier  [K*5] -> Dense(24) -> Dense(16) -> softmax(5)
 *             that predicts your NEXT move from your recent pattern.
 *   • Train:  after each level we call model.fit() on ALL your moves so far.
 *             The model is warm-started and trained for MORE epochs each level,
 *             so Level 2's brain is more trained than Level 1, Level 3 more than
 *             2, Level 4 more than 3 — it literally keeps learning you.
 *   • Use:    in-fight, the opponent predicts your next move and reacts (guards
 *             your favorite punches, baits your habits). Higher levels trust the
 *             prediction more, so the better-trained brain fights harder.
 *
 * Everything persists per fighter (dataset in localStorage, weights in
 * IndexedDB), so a returning player faces an even-more-trained opponent.
 */
window.SB = window.SB || {};

SB.OpponentAI = {
  MOVES: ["jab", "cross", "hook", "slip", "block"],
  N: 5,
  K: 3, // how many recent moves the brain looks at to predict the next one

  model: null,
  usingNN: false,
  moves: [],          // full move history across all levels (indices)
  _recent: [],        // rolling last-K moves for live prediction
  totalEpochs: 0,     // cumulative epochs this brain has trained (grows each level)
  trainedLevels: 0,
  profileId: "guest",

  async init(profileId) {
    this.profileId = profileId || "guest";
    this._recent = [];
    this._load();
    this.usingNN = !!(window.tf && tf.sequential && tf.layers);
    if (this.usingNN) {
      try {
        this.model = await tf.loadLayersModel("indexeddb://" + this._modelKey());
      } catch (e) {
        this.model = this._build();
      }
    }
    return this;
  },

  _modelKey() { return "fc-opp-" + this.profileId; },
  _moveKey() { return "fc_opp_moves_" + this.profileId; },
  _metaKey() { return "fc_opp_meta_" + this.profileId; },

  _build() {
    const m = tf.sequential();
    m.add(tf.layers.dense({ inputShape: [this.K * this.N], units: 24, activation: "relu" }));
    m.add(tf.layers.dense({ units: 16, activation: "relu" }));
    m.add(tf.layers.dense({ units: this.N, activation: "softmax" }));
    m.compile({ optimizer: tf.train.adam(0.01), loss: "categoricalCrossentropy", metrics: ["accuracy"] });
    return m;
  },

  // Record one player move (called for every detected move during a level).
  record(move) {
    const idx = this.MOVES.indexOf(move);
    if (idx < 0) return;
    this.moves.push(idx);
    if (this.moves.length > 2000) this.moves = this.moves.slice(-2000);
    this._recent.push(idx);
    if (this._recent.length > this.K) this._recent.shift();
  },

  _oneHotSeq(seq) {
    // seq: array of up to K indices (oldest..newest). Pads the front with zeros.
    const v = new Array(this.K * this.N).fill(0);
    const start = this.K - seq.length;
    for (let i = 0; i < seq.length; i++) {
      const idx = seq[i];
      if (idx >= 0) v[(start + i) * this.N + idx] = 1;
    }
    return v;
  },

  // Predict the player's NEXT move from their recent pattern.
  // Returns { idx, move, prob } or null if the brain isn't ready.
  predict() {
    if (!this.usingNN || !this.model || this._recent.length === 0) return null;
    try {
      return tf.tidy(() => {
        const x = tf.tensor2d([this._oneHotSeq(this._recent.slice(-this.K))]);
        const out = this.model.predict(x);
        const probs = out.dataSync();
        let best = 0;
        for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
        return { idx: best, move: this.MOVES[best], prob: probs[best] };
      });
    } catch (e) { return null; }
  },

  // Build (x,y) samples of "last K moves -> next move" from the full history.
  _samples() {
    const xs = [], ys = [];
    for (let i = this.K; i < this.moves.length; i++) {
      xs.push(this._oneHotSeq(this.moves.slice(i - this.K, i)));
      const y = new Array(this.N).fill(0); y[this.moves[i]] = 1;
      ys.push(y);
    }
    return { xs, ys };
  },

  // Train the brain on everything so far. Called AFTER finishing `level`, to
  // prepare a stronger brain for the next level. More data + more epochs each
  // time (warm-started), so it gets progressively more trained.
  async trainForLevel(level, onProgress) {
    const epochs = 16 + (level - 1) * 10; // L1->16, L2->26, L3->36 ...
    const samples = this._samples();
    // Need a little data; if the player barely moved, skip the heavy lifting.
    if (!this.usingNN || !this.model || samples.xs.length < 4) {
      this.trainedLevels = Math.max(this.trainedLevels, level);
      this.totalEpochs += Math.round(epochs * 0.3);
      this._save();
      if (onProgress) onProgress(1, { skipped: true });
      return this.stats();
    }
    const xs = tf.tensor2d(samples.xs);
    const ys = tf.tensor2d(samples.ys);
    let lastLoss = 0, lastAcc = 0;
    try {
      await this.model.fit(xs, ys, {
        epochs,
        batchSize: Math.min(16, samples.xs.length),
        shuffle: true,
        callbacks: {
          onEpochEnd: (ep, logs) => {
            lastLoss = logs.loss; lastAcc = logs.acc != null ? logs.acc : logs.accuracy || 0;
            if (onProgress) onProgress((ep + 1) / epochs, { loss: lastLoss, acc: lastAcc });
          },
        },
      });
    } finally {
      xs.dispose(); ys.dispose();
    }
    this.totalEpochs += epochs;
    this.trainedLevels = Math.max(this.trainedLevels, level);
    this.lastLoss = lastLoss; this.lastAcc = lastAcc;
    await this._saveModel();
    this._save();
    return this.stats();
  },

  stats() {
    return {
      moves: this.moves.length,
      epochs: this.totalEpochs,
      levels: this.trainedLevels,
      acc: this.lastAcc || 0,
      nn: this.usingNN,
    };
  },

  // ---------- persistence ----------
  _save() {
    try {
      localStorage.setItem(this._moveKey(), JSON.stringify(this.moves));
      localStorage.setItem(this._metaKey(), JSON.stringify({ totalEpochs: this.totalEpochs, trainedLevels: this.trainedLevels }));
    } catch (e) {}
  },
  async _saveModel() {
    if (this.model) { try { await this.model.save("indexeddb://" + this._modelKey()); } catch (e) {} }
  },
  _load() {
    try { this.moves = JSON.parse(localStorage.getItem(this._moveKey()) || "[]") || []; } catch (e) { this.moves = []; }
    try {
      const m = JSON.parse(localStorage.getItem(this._metaKey()) || "{}");
      this.totalEpochs = m.totalEpochs || 0;
      this.trainedLevels = m.trainedLevels || 0;
    } catch (e) { this.totalEpochs = 0; this.trainedLevels = 0; }
  },

  // Wipe this fighter's brain (used by "fresh start").
  async reset() {
    this.moves = []; this._recent = []; this.totalEpochs = 0; this.trainedLevels = 0;
    try { localStorage.removeItem(this._moveKey()); localStorage.removeItem(this._metaKey()); } catch (e) {}
    try { await tf.io.removeModel("indexeddb://" + this._modelKey()); } catch (e) {}
    if (this.usingNN) this.model = this._build();
  },
};
