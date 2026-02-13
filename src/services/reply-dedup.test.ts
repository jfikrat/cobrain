import { test, expect } from "bun:test";
import { markReplied, wasRecentlyReplied } from "./reply-dedup.ts";

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
