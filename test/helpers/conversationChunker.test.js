const test = require("node:test");
const assert = require("node:assert/strict");

const { chunkConversation } = require("../../src/helpers/conversationChunker.js");

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const system = (content) => ({ role: "system", content });

test("empty messages array returns empty chunks", () => {
  assert.deepEqual(chunkConversation("Title", []), []);
});

test("only system messages returns empty chunks", () => {
  assert.deepEqual(chunkConversation("Title", [system("You are helpful.")]), []);
});

test("small conversation (≤ 5 messages) produces a single chunk", () => {
  const messages = [user("Hello"), assistant("Hi"), user("How are you?")];
  const chunks = chunkConversation("My Chat", messages);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunkIndex, 0);
});

test("single chunk contains the title", () => {
  const messages = [user("Hello"), assistant("Hi")];
  const [chunk] = chunkConversation("MyTitle", messages);
  assert.ok(chunk.text.startsWith("MyTitle"), `expected text to start with title`);
});

test("single chunk contains message content", () => {
  const messages = [user("What is 2+2?"), assistant("4")];
  const [chunk] = chunkConversation("Math", messages);
  assert.ok(chunk.text.includes("What is 2+2?"));
  assert.ok(chunk.text.includes("4"));
});

test("system messages are excluded from chunk content", () => {
  const messages = [system("Be brief."), user("Hello"), assistant("Hi")];
  const [chunk] = chunkConversation("Title", messages);
  assert.ok(!chunk.text.includes("Be brief."), "system message should not appear in chunk");
});

test("large conversation produces multiple overlapping chunks", () => {
  const messages = Array.from({ length: 10 }, (_, i) =>
    i % 2 === 0 ? user(`msg-${i}`) : assistant(`reply-${i}`)
  );
  const chunks = chunkConversation("Long Chat", messages);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
});

test("chunk indices are sequential", () => {
  const messages = Array.from({ length: 10 }, (_, i) => user(`msg-${i}`));
  const chunks = chunkConversation("Sequential", messages);
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.chunkIndex, i);
  });
});

test("chunks with overlap share some messages", () => {
  // 10 messages: window=5, step=3 → overlap of 2
  const messages = Array.from({ length: 10 }, (_, i) => user(`unique-msg-${i}`));
  const chunks = chunkConversation("Overlap Test", messages);
  assert.ok(chunks.length >= 2);
  // First chunk has msg-0..4, second has msg-3..7 (overlap at 3,4)
  assert.ok(chunks[0].text.includes("unique-msg-0"));
  assert.ok(chunks[1].text.includes("unique-msg-3"));
});

test("chunk text is truncated at 1500 characters", () => {
  const longContent = "x".repeat(300);
  const messages = Array.from({ length: 5 }, () => user(longContent));
  const [chunk] = chunkConversation("Big", messages);
  assert.ok(chunk.text.length <= 1500, `text length ${chunk.text.length} exceeds 1500`);
});
