/**
 * Test script for Claude tmux Session
 */

import { ClaudeTmuxSession } from "../src/services/claude-session.ts";

async function main() {
  console.log("=== Claude tmux Session Test ===\n");

  // Önce eski test session'ı temizle
  await Bun.$`tmux kill-session -t cobrain-test 2>/dev/null || true`;

  const session = new ClaudeTmuxSession({
    userId: 999999, // Test user
    workDir: "/home/fekrat/projects/cobrain",
    timeout: 60_000,
  });

  try {
    console.log("Starting session...");
    await session.start();
    console.log("Session started!\n");

    // Test 1: Simple question
    console.log("--- Test 1: Simple question ---");
    const response1 = await session.chat("What is 2+2? Answer in one word.");
    console.log("Response:", response1.content);
    console.log();

    // Test 2: Follow-up (context test)
    console.log("--- Test 2: Follow-up question ---");
    const response2 = await session.chat("What was my previous question?");
    console.log("Response:", response2.content);
    console.log();

    // Test 3: Turkish
    console.log("--- Test 3: Turkish ---");
    const response3 = await session.chat("Merhaba! Benim adım Fekrat. Senin adın ne?");
    console.log("Response:", response3.content);
    console.log();

    console.log("=== All tests passed! ===");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    console.log("\nStopping session...");
    await session.stop();
    console.log("Done!");
  }
}

main();
