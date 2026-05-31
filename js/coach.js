/*
 * coach.js — the AI coach voice.
 *
 * Uses the OpenAI Chat Completions API (key from SB.config) to generate short,
 * punchy boxing-coach commentary: round intros, corrections, and wrap-ups.
 * Calls are throttled and always have a local fallback line, so the game stays
 * fun and fully playable even with no key / no network.
 *
 * No video or pose data ever leaves the browser — we only send a tiny text
 * summary of what happened (e.g. "player landed 6 jabs, dropped guard twice").
 */
window.SB = window.SB || {};

SB.Coach = {
  _last: 0,
  minGapMs: 4000,

  // Local fallback lines so it's never silent.
  _fallback: {
    intro: ["Hands up, chin down. Let's work.", "Stay light on your feet. Here we go.", "Find your range and stay sharp."],
    good: ["Nice and crisp!", "That's the shot!", "Beautiful timing.", "Keep that rhythm."],
    fix: ["Get that guard back up.", "Turn the hip into it.", "Don't reach — let it snap.", "Stop telegraphing, stay loose."],
    win: ["That's the round! Clean work.", "You ran that round. Great boxing.", "Dominant. Take a breath."],
    lose: ["Shake it off — reset and go again.", "Tough round. Tighten the guard next time.", "Learn from it. Round's not the war."],
  },

  pick(kind) {
    const arr = this._fallback[kind] || this._fallback.good;
    return arr[Math.floor(Math.random() * arr.length)];
  },

  // summary: short text. kind: intro|good|fix|win|lose. cb(text)
  async say(kind, summary, cb) {
    const fallback = this.pick(kind);
    const now = performance.now();
    if (!SB.config.hasKey() || now - this._last < this.minGapMs) {
      cb(fallback);
      return;
    }
    this._last = now;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + SB.config.getKey(),
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.8,
          max_tokens: 30,
          messages: [
            {
              role: "system",
              content:
                "You are a high-energy boxing coach in a webcam fitness game called ShadowBox. " +
                "Reply with ONE short spoken line (max 12 words), no quotes, no emoji. Be motivating and specific.",
            },
            { role: "user", content: `Context (${kind}): ${summary}` },
          ],
        }),
      });
      if (!res.ok) throw new Error("openai " + res.status);
      const data = await res.json();
      const line = data.choices?.[0]?.message?.content?.trim();
      cb(line || fallback);
    } catch (e) {
      cb(fallback);
    }
  },
};
