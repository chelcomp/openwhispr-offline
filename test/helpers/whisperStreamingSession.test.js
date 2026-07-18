const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWhisperVadStreamingSession,
  bufferRms,
} = require("../../src/helpers/whisperStreamingSession.js");

const SAMPLE_RATE = 16000;

// Build a PCM16 mono buffer of `ms` milliseconds at a given normalized amplitude
// (0..1). amplitude 0 = digital silence; ~0.2 = comfortably above the VAD floor.
function pcm(ms, amplitude) {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // Alternate sign so the frame RMS reflects the amplitude (not a DC offset).
    const s = (i % 2 === 0 ? amplitude : -amplitude) * 0x7fff;
    buf.writeInt16LE(Math.round(s), i * 2);
  }
  return buf;
}

// Deterministic config so tests don't depend on the shipped VAD defaults.
const VAD = {
  minSpeechDurationMs: 100,
  minSilenceDurationMs: 200,
  maxSpeechDurationS: 30,
  speechPadMs: 100,
  samplesOverlap: 0.2,
  threshold: 0.5,
};

function makeSession(overrides = {}) {
  const commits = [];
  const partials = [];
  const errors = [];
  let calls = 0;
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    onCommit: (t) => commits.push(t),
    onPartial: (t) => partials.push(t),
    onError: (e) => errors.push(e),
    transcribe: async () => {
      calls += 1;
      return `seg${calls}`;
    },
    ...overrides,
  });
  return { session, commits, partials, errors, callCount: () => calls };
}

test("commits one segment per silence-delimited utterance", async () => {
  const { session, commits } = makeSession();

  session.pushPcm16(pcm(300, 0)); // lead-in silence
  session.pushPcm16(pcm(500, 0.2)); // utterance 1
  session.pushPcm16(pcm(400, 0)); // silence closes utterance 1
  session.pushPcm16(pcm(500, 0.2)); // utterance 2
  session.pushPcm16(pcm(400, 0)); // silence closes utterance 2

  const result = await session.finish();

  assert.equal(commits.length, 2, "two utterances should commit");
  assert.deepEqual(commits, ["seg1", "seg2"]);
  assert.equal(result.text, "seg1 seg2");
});

test("finish() flushes an utterance left open with no trailing silence", async () => {
  const { session, commits } = makeSession();

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2)); // speech, then hotkey release (no trailing silence)

  const result = await session.finish();

  assert.equal(commits.length, 1);
  assert.equal(result.text, "seg1");
});

test("pure silence produces no inference calls", async () => {
  const { session, commits, callCount } = makeSession();

  session.pushPcm16(pcm(2000, 0));
  const result = await session.finish();

  assert.equal(callCount(), 0, "silence must never hit whisper-server");
  assert.equal(commits.length, 0);
  assert.equal(result.text, "");
});

test("a very long pauseless utterance is force-committed at the cap", async () => {
  const { session, commits } = makeSession({ vadConfig: { ...VAD, maxSpeechDurationS: 1 } });

  session.pushPcm16(pcm(200, 0));
  // 2.5s of continuous speech with a 1s cap -> at least two forced commits.
  session.pushPcm16(pcm(2500, 0.2));
  const result = await session.finish();

  assert.ok(commits.length >= 2, `expected >=2 forced commits, got ${commits.length}`);
  assert.ok(result.text.length > 0);
});

test("abort() drops queued work and fires no callbacks", async () => {
  let resolveTranscribe;
  const gate = new Promise((r) => {
    resolveTranscribe = r;
  });
  const commits = [];
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    onCommit: (t) => commits.push(t),
    transcribe: async () => {
      await gate;
      return "late";
    },
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2));
  session.pushPcm16(pcm(400, 0)); // enqueues a commit that is now in flight
  session.abort();
  resolveTranscribe();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(commits.length, 0, "aborted session must not commit");
});

test("partials never run while a commit is queued", async () => {
  const order = [];
  let resolveFirst;
  const firstGate = new Promise((r) => {
    resolveFirst = r;
  });
  let call = 0;
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    onCommit: (t) => order.push(`commit:${t}`),
    onPartial: (t) => order.push(`partial:${t}`),
    transcribe: async () => {
      call += 1;
      if (call === 1) await firstGate; // hold the first commit in flight
      return `t${call}`;
    },
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2));
  session.pushPcm16(pcm(400, 0)); // commit #1 starts, held by firstGate
  session.pushPcm16(pcm(500, 0.2)); // new open utterance
  session.requestPartial(); // must be ignored: an inference is in flight
  assert.equal(order.length, 0, "partial must not preempt an in-flight commit");

  resolveFirst();
  await session.finish();

  assert.ok(
    order.some((o) => o.startsWith("commit:")),
    "commits should have fired"
  );
});

test("bufferRms is zero for digital silence and positive for tone", () => {
  assert.equal(bufferRms(pcm(100, 0)), 0);
  assert.ok(bufferRms(pcm(100, 0.2)) > 0.1);
});

test("a low-quality utterance is deferred and merged into the next", async () => {
  const commits = [];
  const partials = [];
  let call = 0;
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    onCommit: (t) => commits.push(t),
    onPartial: (t) => partials.push(t),
    // First inference is flagged low quality; the merged one is fine.
    isLowQuality: (q) => q?.bad === true,
    transcribe: async () => {
      call += 1;
      return call === 1 ? { text: "a", quality: { bad: true } } : { text: "a b", quality: {} };
    },
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2)); // utterance 1 -> low quality -> deferred
  session.pushPcm16(pcm(400, 0));
  session.pushPcm16(pcm(500, 0.2)); // utterance 2 -> merged with #1
  session.pushPcm16(pcm(400, 0));

  const result = await session.finish();

  assert.equal(commits.length, 1, "the deferred + next audio commit exactly once");
  assert.equal(commits[0], "a b");
  assert.equal(result.text, "a b");
  assert.ok(partials.includes("a"), "the low-quality text is shown provisionally");
  assert.equal(result.finalized, true);
});

test("merging stops at the merge cap and commits best-effort", async () => {
  const commits = [];
  let call = 0;
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    maxMerges: 1,
    onCommit: (t) => commits.push(t),
    isLowQuality: () => true, // always "low" — the cap must break the loop
    transcribe: async () => {
      call += 1;
      return { text: `t${call}`, quality: { bad: true } };
    },
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2)); // #1 low -> defer (mergeCount 1)
  session.pushPcm16(pcm(400, 0));
  session.pushPcm16(pcm(500, 0.2)); // #2 -> cap hit -> commit despite low
  session.pushPcm16(pcm(400, 0));

  const result = await session.finish();

  assert.equal(commits.length, 1, "cap forces a single best-effort commit");
  assert.ok(result.text.length > 0);
});

test("finish() force-commits a deferred tail with no following utterance", async () => {
  const commits = [];
  let call = 0;
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    onCommit: (t) => commits.push(t),
    isLowQuality: () => true,
    transcribe: async () => {
      call += 1;
      return { text: `tail${call}`, quality: { bad: true } };
    },
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2)); // low -> deferred
  session.pushPcm16(pcm(400, 0)); // silence closes it; nothing follows

  const result = await session.finish();

  assert.equal(commits.length, 1, "the deferred tail must not be lost");
  assert.ok(result.text.startsWith("tail"));
});

test("finish() reports a high lowQualityRatio when committed audio stays poor", async () => {
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    maxMerges: 0, // no room to merge -> a low-quality utterance commits best-effort
    onCommit: () => {},
    isLowQuality: () => true, // everything is low confidence
    transcribe: async () => ({ text: "meh", quality: { bad: true } }),
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2));
  session.pushPcm16(pcm(400, 0));

  const result = await session.finish();

  assert.ok(result.quality.committedMs > 0);
  assert.equal(result.quality.lowQualityRatio, 1, "all committed audio was low quality");
});

test("finish() reports lowQualityRatio 0 for confident output", async () => {
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    onCommit: () => {},
    isLowQuality: () => false,
    transcribe: async () => ({ text: "clean", quality: {} }),
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2));
  session.pushPcm16(pcm(400, 0));

  const result = await session.finish();

  assert.equal(result.quality.lowQualityRatio, 0);
});

test("finish() reports finalized=false when an inference errors", async () => {
  const session = createWhisperVadStreamingSession({
    vadConfig: VAD,
    onError: () => {},
    transcribe: async () => {
      throw new Error("boom");
    },
  });

  session.pushPcm16(pcm(300, 0));
  session.pushPcm16(pcm(500, 0.2));
  session.pushPcm16(pcm(400, 0));

  const result = await session.finish();

  assert.equal(result.finalized, false);
});
