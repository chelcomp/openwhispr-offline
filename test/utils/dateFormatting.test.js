const test = require("node:test");
const assert = require("node:assert/strict");

// dateFormatting.ts has no imports from other TS files.
const load = () => import("../../src/utils/dateFormatting.ts");

// normalizeDbDate

test("normalizeDbDate appends Z for dates without timezone", async () => {
  const { normalizeDbDate } = await load();
  const d = normalizeDbDate("2024-06-15T10:30:00");
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), "2024-06-15T10:30:00.000Z");
});

test("normalizeDbDate does not double-append Z when already present", async () => {
  const { normalizeDbDate } = await load();
  const d = normalizeDbDate("2024-06-15T10:30:00Z");
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), "2024-06-15T10:30:00.000Z");
});

test("normalizeDbDate parses date-only string", async () => {
  const { normalizeDbDate } = await load();
  const d = normalizeDbDate("2024-01-01");
  assert.ok(d instanceof Date);
  assert.ok(!isNaN(d.getTime()));
});

// formatDateGroup

test("formatDateGroup returns today key for today's date", async () => {
  const { formatDateGroup } = await load();
  const today = new Date();
  const t = (key) => key;
  const result = formatDateGroup(today, t);
  assert.equal(result, "controlPanel.history.dateGroups.today");
});

test("formatDateGroup returns yesterday key for yesterday's date", async () => {
  const { formatDateGroup } = await load();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const t = (key) => key;
  const result = formatDateGroup(yesterday, t);
  assert.equal(result, "controlPanel.history.dateGroups.yesterday");
});

test("formatDateGroup returns locale date string for older dates", async () => {
  const { formatDateGroup } = await load();
  const old = new Date("2020-01-15T12:00:00Z");
  const t = (key) => key;
  const result = formatDateGroup(old, t);
  assert.ok(typeof result === "string");
  assert.ok(result !== "controlPanel.history.dateGroups.today");
  assert.ok(result !== "controlPanel.history.dateGroups.yesterday");
});

test("formatDateGroup accepts string input", async () => {
  const { formatDateGroup } = await load();
  const t = (key) => key;
  const result = formatDateGroup(new Date().toISOString(), t);
  assert.equal(result, "controlPanel.history.dateGroups.today");
});

// formatUpcomingDateGroup

test("formatUpcomingDateGroup returns today key for today's date", async () => {
  const { formatUpcomingDateGroup } = await load();
  const today = new Date();
  const t = (key) => key;
  const result = formatUpcomingDateGroup(today, t);
  assert.equal(result, "controlPanel.history.dateGroups.today");
});

test("formatUpcomingDateGroup returns tomorrow key for tomorrow's date", async () => {
  const { formatUpcomingDateGroup } = await load();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const t = (key) => key;
  const result = formatUpcomingDateGroup(tomorrow, t);
  assert.equal(result, "upcoming.tomorrow");
});
