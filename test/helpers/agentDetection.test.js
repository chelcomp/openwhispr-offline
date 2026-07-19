const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/agentDetection.ts");

test("matches the name when it starts the dictation", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("EktosWhispr, summarize this note", "EktosWhispr"), true);
  assert.equal(detectAgentName("Max take a note", "Max"), true);
});

test("matches the name after a greeting cue", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("hey EktosWhispr make this formal", "EktosWhispr"), true);
  assert.equal(detectAgentName("okay Max stop recording", "Max"), true);
});

test("matches the name opening a new sentence", async () => {
  const { detectAgentName } = await load();

  assert.equal(
    detectAgentName("That's everything. EktosWhispr, format this as bullets", "EktosWhispr"),
    true
  );
});

test("ignores mentions that are dictated content, not commands", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("I showed EktosWhispr to a friend yesterday", "EktosWhispr"), false);
  assert.equal(detectAgentName("we shipped the EktosWhispr update today", "EktosWhispr"), false);
  assert.equal(detectAgentName("the max value is ten", "Max"), false);
});

test("handles STT splitting or misspelling the name, with the same gating", async () => {
  const { detectAgentName } = await load();

  // Split across tokens ("Ektos Whisper") and misheard endings still match
  // when addressed...
  assert.equal(detectAgentName("hey ektos whisper translate this", "EktosWhispr"), true);
  assert.equal(detectAgentName("Ektos Whispr, take a note", "EktosWhispr"), true);
  // ...but not as a mid-sentence mention.
  assert.equal(
    detectAgentName("people keep calling ektos whisper a dictation app", "EktosWhispr"),
    false
  );
});

test("short names never fuzzy-match other words", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("Sam, what time is it", "Max"), false);
  assert.equal(detectAgentName("the maximum value is ten", "Max"), false);
});

test("rejects empty or single-character names", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("hey there", ""), false);
  assert.equal(detectAgentName("a quick note", "a"), false);
});
