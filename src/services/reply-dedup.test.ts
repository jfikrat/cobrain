import { test, expect, beforeEach, afterEach, describe, setSystemTime } from "bun:test";
import { markReplied, wasRecentlyReplied, clearAll, TTL_MS } from "./reply-dedup.ts";

beforeEach(() => {
  clearAll();
});

afterEach(() => {
  // Restore real time after each test
  setSystemTime();
});

// ── Basic behaviour ──────────────────────────────────────────────────────

test("wasRecentlyReplied returns false for unknown chat", () => {
  expect(wasRecentlyReplied("unknown@s.whatsapp.net")).toBe(false);
});

test("markReplied + wasRecentlyReplied works", () => {
  const chatJid = "test-mark@s.whatsapp.net";
  markReplied(chatJid);
  expect(wasRecentlyReplied(chatJid)).toBe(true);
});

test("different chats are independent", () => {
  const chat1 = "chat1@s.whatsapp.net";
  const chat2 = "chat2@s.whatsapp.net";
  markReplied(chat1);
  expect(wasRecentlyReplied(chat1)).toBe(true);
  expect(wasRecentlyReplied(chat2)).toBe(false);
});

// ── clearAll ─────────────────────────────────────────────────────────────

describe("clearAll", () => {
  test("removes all entries", () => {
    markReplied("a@s.whatsapp.net");
    markReplied("b@s.whatsapp.net");
    markReplied("c@s.whatsapp.net");
    clearAll();
    expect(wasRecentlyReplied("a@s.whatsapp.net")).toBe(false);
    expect(wasRecentlyReplied("b@s.whatsapp.net")).toBe(false);
    expect(wasRecentlyReplied("c@s.whatsapp.net")).toBe(false);
  });

  test("after clearAll, new markReplied works normally", () => {
    markReplied("x@s.whatsapp.net");
    clearAll();
    expect(wasRecentlyReplied("x@s.whatsapp.net")).toBe(false);

    markReplied("x@s.whatsapp.net");
    expect(wasRecentlyReplied("x@s.whatsapp.net")).toBe(true);
  });
});

// ── TTL expiry (fake timers) ─────────────────────────────────────────────

describe("TTL expiry", () => {
  test("entry expires after TTL_MS", () => {
    const now = new Date("2026-02-14T12:00:00Z");
    setSystemTime(now);

    markReplied("expire@s.whatsapp.net");
    expect(wasRecentlyReplied("expire@s.whatsapp.net")).toBe(true);

    // Advance just under TTL — should still be valid
    setSystemTime(new Date(now.getTime() + TTL_MS - 1));
    expect(wasRecentlyReplied("expire@s.whatsapp.net")).toBe(true);

    // Advance past TTL — should be expired
    setSystemTime(new Date(now.getTime() + TTL_MS + 1));
    expect(wasRecentlyReplied("expire@s.whatsapp.net")).toBe(false);
  });

  test("re-marking resets the TTL", () => {
    const now = new Date("2026-02-14T12:00:00Z");
    setSystemTime(now);

    markReplied("reset@s.whatsapp.net");

    // Advance 50s (within TTL)
    const at50s = new Date(now.getTime() + 50_000);
    setSystemTime(at50s);
    expect(wasRecentlyReplied("reset@s.whatsapp.net")).toBe(true);

    // Re-mark at 50s — TTL resets from this point
    markReplied("reset@s.whatsapp.net");

    // At 90s from original (40s from re-mark) — should still be valid
    setSystemTime(new Date(now.getTime() + 90_000));
    expect(wasRecentlyReplied("reset@s.whatsapp.net")).toBe(true);

    // At 111s from original (61s from re-mark at 50s) — should be expired
    setSystemTime(new Date(at50s.getTime() + TTL_MS + 1));
    expect(wasRecentlyReplied("reset@s.whatsapp.net")).toBe(false);
  });
});

// ── Rapid sequential markReplied ─────────────────────────────────────────

describe("rapid sequential markReplied", () => {
  test("multiple rapid marks for same chat do not cause issues", () => {
    const now = new Date("2026-02-14T12:00:00Z");
    setSystemTime(now);

    // Rapid-fire markReplied for the same chat
    markReplied("rapid@s.whatsapp.net");
    markReplied("rapid@s.whatsapp.net");
    markReplied("rapid@s.whatsapp.net");

    expect(wasRecentlyReplied("rapid@s.whatsapp.net")).toBe(true);

    // Last write wins — TTL is from the last mark
    setSystemTime(new Date(now.getTime() + TTL_MS + 1));
    expect(wasRecentlyReplied("rapid@s.whatsapp.net")).toBe(false);
  });

  test("rapid marks for different chats all register independently", () => {
    markReplied("r1@s.whatsapp.net");
    markReplied("r2@s.whatsapp.net");
    markReplied("r3@s.whatsapp.net");

    expect(wasRecentlyReplied("r1@s.whatsapp.net")).toBe(true);
    expect(wasRecentlyReplied("r2@s.whatsapp.net")).toBe(true);
    expect(wasRecentlyReplied("r3@s.whatsapp.net")).toBe(true);
    expect(wasRecentlyReplied("r4@s.whatsapp.net")).toBe(false);
  });
});

// ── TTL constant ─────────────────────────────────────────────────────────

test("TTL_MS is 60 seconds", () => {
  expect(TTL_MS).toBe(60_000);
});
