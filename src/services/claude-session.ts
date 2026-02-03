/**
 * Claude tmux Session Manager
 * Uses tmux for input, JSONL session files for output
 * Cobrain v0.2
 */

import { $ } from "bun";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { EventEmitter } from "events";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolUse?: { name: string; input: unknown }[];
}

export interface ClaudeSessionConfig {
  userId: number;
  workDir: string;
  timeout?: number;
}

interface SessionLine {
  type: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

/**
 * Encode directory path to Claude's project folder format
 */
function encodeProjectPath(dir: string): string {
  // Claude encodes: dot to dash first, then slash to dash
  // e.g., /home/user/.cobrain → /home/user/-cobrain → -home-user--cobrain
  return dir.replace(/\./g, "-").replace(/\//g, "-");
}

/**
 * Get Claude projects base directory
 */
function getClaudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Inactivity timeout (30 minutes)
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class ClaudeTmuxSession extends EventEmitter {
  private tmuxSession: string;
  private sessionFile: string | null = null;
  private workDir: string;
  private userId: number;
  private timeout: number;
  private ready: boolean = false;
  private startTime: number = 0;
  private lastActivityTime: number = 0;
  private claudeSessionId: string | null = null; // For --resume

  constructor(config: ClaudeSessionConfig) {
    super();
    this.userId = config.userId;
    this.workDir = config.workDir;
    this.timeout = config.timeout || 120_000;
    this.tmuxSession = `cobrain-${this.userId}`;
  }

  /**
   * Get the Claude session ID (for resume)
   */
  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  /**
   * Set Claude session ID (for resume after timeout)
   */
  setClaudeSessionId(sessionId: string): void {
    this.claudeSessionId = sessionId;
  }

  /**
   * Get last activity time
   */
  getLastActivityTime(): number {
    return this.lastActivityTime;
  }

  /**
   * Check if session is inactive (past timeout)
   */
  isInactive(): boolean {
    if (!this.ready || this.lastActivityTime === 0) return false;
    return Date.now() - this.lastActivityTime > INACTIVITY_TIMEOUT_MS;
  }

  /**
   * Check if tmux session exists
   */
  private async tmuxHasSession(): Promise<boolean> {
    try {
      await $`tmux has-session -t ${this.tmuxSession}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture tmux pane content
   */
  private async tmuxCapture(): Promise<string> {
    try {
      return await $`tmux capture-pane -t ${this.tmuxSession} -p`.text();
    } catch {
      return "";
    }
  }

  /**
   * Send keys to tmux session
   */
  private async tmuxSendKeys(text: string, enter: boolean = false): Promise<void> {
    if (enter) {
      await $`tmux send-keys -t ${this.tmuxSession} ${text} Enter`;
    } else {
      await $`tmux send-keys -t ${this.tmuxSession} ${text}`;
    }
  }

  /**
   * Start the Claude CLI session in tmux
   */
  async start(): Promise<void> {
    this.startTime = Date.now();
    this.lastActivityTime = Date.now();

    console.log(`[ClaudeSession] Starting for user ${this.userId}...`);

    // Kill existing session if any
    if (await this.tmuxHasSession()) {
      console.log(`[ClaudeSession] Killing existing session...`);
      await $`tmux kill-session -t ${this.tmuxSession}`.quiet().catch(() => {});
      await sleep(500);
    }

    // Create new tmux session
    console.log(`[ClaudeSession] Creating tmux session: ${this.tmuxSession}`);
    await $`tmux new-session -d -s ${this.tmuxSession} -c ${this.workDir}`;
    await sleep(500);

    // Start Claude CLI (with --resume if we have a previous session)
    if (this.claudeSessionId) {
      console.log(`[ClaudeSession] Resuming Claude session: ${this.claudeSessionId.slice(0, 8)}...`);
      await this.tmuxSendKeys(`claude --dangerously-skip-permissions --resume ${this.claudeSessionId}`, true);
    } else {
      console.log(`[ClaudeSession] Launching new Claude CLI...`);
      await this.tmuxSendKeys("claude --dangerously-skip-permissions", true);
    }

    // Wait for Claude to be ready
    await this.waitForReady();

    // Find session file
    await this.findSessionFile();

    // Extract session ID from filename
    if (this.sessionFile && !this.claudeSessionId) {
      const filename = this.sessionFile.split("/").pop();
      if (filename) {
        this.claudeSessionId = filename.replace(".jsonl", "");
        console.log(`[ClaudeSession] Session ID: ${this.claudeSessionId.slice(0, 8)}...`);
      }
    }

    this.ready = true;
    console.log(`[ClaudeSession] Ready! Session file: ${this.sessionFile}`);
  }

  /**
   * Wait for Claude CLI to be ready (show prompt)
   */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const pane = await this.tmuxCapture();

      // Claude CLI shows these when ready
      if (pane.includes("❯") || pane.includes("›") || pane.includes("Claude Code")) {
        console.log(`[ClaudeSession] Claude prompt detected!`);
        return;
      }

      await sleep(1000);
    }

    throw new Error("Claude CLI startup timeout");
  }

  /**
   * Find the session file created by this Claude instance
   */
  private async findSessionFile(): Promise<void> {
    const projectFolder = encodeProjectPath(this.workDir);
    const projectDir = join(getClaudeProjectsDir(), projectFolder);

    console.log(`[ClaudeSession] Looking for session file in: ${projectDir}`);

    // Wait for session file to be created
    const deadline = Date.now() + 15_000;

    // Track files that existed before we started (with their sizes)
    const existingFiles = new Map<string, number>();
    try {
      const files = await readdir(projectDir);
      for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
        const filePath = join(projectDir, f);
        const fileStat = await Bun.file(filePath).stat();
        if (fileStat) {
          existingFiles.set(f, fileStat.size);
        }
      }
      console.log(`[ClaudeSession] Found ${existingFiles.size} existing session files`);
    } catch {
      // Directory might not exist
    }

    while (Date.now() < deadline) {
      try {
        const files = await readdir(projectDir);
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

        // Find a NEW file (didn't exist when we started)
        for (const file of jsonlFiles) {
          if (!existingFiles.has(file)) {
            const filePath = join(projectDir, file);
            this.sessionFile = filePath;
            console.log(`[ClaudeSession] Found NEW session file: ${file}`);
            return;
          }
        }
      } catch {
        // Directory might not exist yet
      }

      await sleep(500);
    }

    // If no NEW file found, we'll detect it after first message by looking for size changes
    console.log(`[ClaudeSession] No new file found, will detect after first message`);
    this.existingFilesSnapshot = existingFiles;
  }

  private existingFilesSnapshot: Map<string, number> = new Map();

  /**
   * Find the NEW session file created after sending first message
   */
  private async findNewSessionFile(): Promise<void> {
    const projectFolder = encodeProjectPath(this.workDir);
    const projectDir = join(getClaudeProjectsDir(), projectFolder);

    console.log(`[ClaudeSession] Looking for new session file...`);

    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      try {
        const files = await readdir(projectDir);
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

        for (const file of jsonlFiles) {
          // Check if this is a NEW file
          if (!this.existingFilesSnapshot.has(file)) {
            const filePath = join(projectDir, file);
            this.sessionFile = filePath;
            // Extract and save session ID for resume
            if (!this.claudeSessionId) {
              this.claudeSessionId = file.replace(".jsonl", "");
              console.log(`[ClaudeSession] Session ID saved: ${this.claudeSessionId.slice(0, 8)}...`);
            }
            console.log(`[ClaudeSession] Found NEW session file: ${file}`);
            return;
          }

          // Check if existing file grew significantly (new session might reuse file)
          const oldSize = this.existingFilesSnapshot.get(file) || 0;
          const filePath = join(projectDir, file);
          const fileStat = await Bun.file(filePath).stat();

          if (fileStat && fileStat.size > oldSize + 500) {
            // File grew, check if it has our message
            try {
              const content = await readFile(filePath, "utf-8");
              const lines = content.trim().split("\n");

              // Look for recent user message
              for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10; i--) {
                const line = lines[i];
                if (!line) continue;

                try {
                  const parsed = JSON.parse(line);
                  if (parsed.timestamp) {
                    const lineTime = new Date(parsed.timestamp).getTime();
                    if (lineTime > this.startTime && parsed.type === "user") {
                      this.sessionFile = filePath;
                      // Extract and save session ID for resume
                      if (!this.claudeSessionId) {
                        this.claudeSessionId = file.replace(".jsonl", "");
                        console.log(`[ClaudeSession] Session ID saved: ${this.claudeSessionId.slice(0, 8)}...`);
                      }
                      console.log(`[ClaudeSession] Found session in existing file: ${file}`);
                      return;
                    }
                  }
                } catch {
                  // Skip invalid line
                }
              }
            } catch {
              // Skip if can't read
            }
          }
        }
      } catch {
        // Directory might not exist
      }

      await sleep(500);
    }

    console.log(`[ClaudeSession] Could not find session file`);
  }

  /**
   * Send a message and wait for response
   */
  async chat(message: string): Promise<ClaudeMessage> {
    if (!this.ready) {
      throw new Error("Session not ready. Call start() first.");
    }

    // Update activity time
    this.lastActivityTime = Date.now();

    // Ensure we have session file
    if (!this.sessionFile) {
      await this.findSessionFile();
    }

    const startTime = Date.now();
    const startLineCount = this.sessionFile ? await this.getLineCount() : 0;

    console.log(`[ClaudeSession] Sending: "${message.slice(0, 50)}..."`);

    // Escape special characters for tmux
    const escapedMessage = message.replace(/'/g, "'\\''");

    // Send message - need two Enters (one to type, one to submit)
    await $`tmux send-keys -t ${this.tmuxSession} -l ${escapedMessage}`;
    await sleep(100);
    await $`tmux send-keys -t ${this.tmuxSession} Enter`;
    await sleep(100);
    await $`tmux send-keys -t ${this.tmuxSession} Enter`;

    // If we didn't have session file, find it now
    if (!this.sessionFile) {
      await sleep(3000);
      await this.findNewSessionFile();

      if (!this.sessionFile) {
        throw new Error("Could not find session file");
      }
    }

    // Wait for response from JSONL file
    return this.waitForResponse(startLineCount, startTime);
  }

  /**
   * Get current line count in session file
   */
  private async getLineCount(): Promise<number> {
    if (!this.sessionFile) return 0;

    try {
      const content = await readFile(this.sessionFile, "utf-8");
      return content.trim().split("\n").length;
    } catch {
      return 0;
    }
  }

  /**
   * Wait for assistant response in session file
   * Waits for Claude to finish all tool calls and provide final text response
   */
  private async waitForResponse(
    afterLine: number,
    startTime: number
  ): Promise<ClaudeMessage> {
    const deadline = startTime + this.timeout;
    let lastLineCount = 0;
    let stableCount = 0;

    while (Date.now() < deadline) {
      try {
        const content = await readFile(this.sessionFile!, "utf-8");
        const lines = content.trim().split("\n").slice(afterLine);

        // Check if session file is still growing (Claude still working)
        if (lines.length !== lastLineCount) {
          lastLineCount = lines.length;
          stableCount = 0;
        } else {
          stableCount++;
        }

        // Only process if file has been stable for 3 iterations (~900ms)
        // This ensures Claude has finished all tool calls
        if (stableCount < 3) {
          await sleep(300);
          continue;
        }

        // Look for the LAST assistant message with text content (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const line = lines[i];
            if (!line) continue;
            const parsed = JSON.parse(line) as SessionLine;

            if (
              parsed.type === "assistant" &&
              parsed.message?.role === "assistant" &&
              parsed.message?.content
            ) {
              const content = parsed.message.content;

              // Handle array content (Claude's format)
              if (Array.isArray(content)) {
                // Skip if this message only has tool_use (no final text yet)
                const hasToolUse = content.some((b: ContentBlock) => b.type === "tool_use");
                const hasText = content.some((b: ContentBlock) => b.type === "text" && b.text);

                // If it has tool_use but no text, skip - Claude is still working
                if (hasToolUse && !hasText) {
                  continue;
                }

                const textParts: string[] = [];
                let thinking: string | undefined;
                const toolUses: { name: string; input: unknown }[] = [];

                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    textParts.push(block.text);
                  } else if (block.type === "thinking" && block.thinking) {
                    thinking = block.thinking;
                  } else if (block.type === "tool_use" && block.name) {
                    toolUses.push({ name: block.name, input: block.input });
                  }
                }

                if (textParts.length > 0) {
                  const responseText = textParts.join("");
                  console.log(
                    `[ClaudeSession] Response received (${responseText.length} chars)`
                  );

                  return {
                    role: "assistant",
                    content: responseText,
                    thinking,
                    toolUse: toolUses.length > 0 ? toolUses : undefined,
                  };
                }
              }

              // Handle string content
              if (typeof content === "string") {
                console.log(
                  `[ClaudeSession] Response received (${content.length} chars)`
                );
                return {
                  role: "assistant",
                  content,
                };
              }
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      } catch {
        // File might not exist yet
      }

      await sleep(300);
    }

    throw new Error("Response timeout");
  }

  /**
   * Check if session is active
   */
  isActive(): boolean {
    return this.ready;
  }

  /**
   * Get tmux session name
   */
  getTmuxSession(): string {
    return this.tmuxSession;
  }

  /**
   * Hibernate the session (kill tmux but keep session ID for resume)
   */
  async hibernate(): Promise<void> {
    console.log(`[ClaudeSession] Hibernating session for user ${this.userId}...`);

    if (await this.tmuxHasSession()) {
      // Send exit command
      await this.tmuxSendKeys("/exit", true);
      await sleep(1000);

      // Kill tmux session
      await $`tmux kill-session -t ${this.tmuxSession}`.quiet().catch(() => {});
    }

    this.ready = false;
    this.sessionFile = null;
    // Keep claudeSessionId for resume!
    console.log(`[ClaudeSession] Hibernated. Session ID preserved: ${this.claudeSessionId?.slice(0, 8)}...`);
  }

  /**
   * Stop the session completely (clear session ID too)
   */
  async stop(): Promise<void> {
    console.log(`[ClaudeSession] Stopping session for user ${this.userId}...`);

    if (await this.tmuxHasSession()) {
      // Send exit command
      await this.tmuxSendKeys("/exit", true);
      await sleep(1000);

      // Kill tmux session
      await $`tmux kill-session -t ${this.tmuxSession}`.quiet().catch(() => {});
    }

    this.ready = false;
    this.sessionFile = null;
    this.claudeSessionId = null; // Clear for full stop
  }
}

// Cleanup interval (check every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Session manager for multiple users
 */
export class ClaudeSessionManager {
  private sessions: Map<number, ClaudeTmuxSession> = new Map();
  private baseWorkDir: string;
  private getUserWorkDir: (userId: number) => string;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(baseWorkDir: string, getUserWorkDir?: (userId: number) => string) {
    this.baseWorkDir = baseWorkDir;
    // Default to base work dir if no user-specific resolver provided
    this.getUserWorkDir = getUserWorkDir || (() => baseWorkDir);
    this.startCleanupInterval();
  }

  /**
   * Start the cleanup interval
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions();
    }, CLEANUP_INTERVAL_MS);

    console.log(`[SessionManager] Cleanup interval started (every ${CLEANUP_INTERVAL_MS / 60000} min)`);
  }

  /**
   * Cleanup inactive sessions (hibernate them)
   */
  private async cleanupInactiveSessions(): Promise<void> {
    const now = Date.now();
    let hibernatedCount = 0;

    for (const [userId, session] of this.sessions) {
      if (session.isActive() && session.isInactive()) {
        console.log(`[SessionManager] User ${userId} inactive, hibernating...`);
        await session.hibernate();
        hibernatedCount++;
      }
    }

    if (hibernatedCount > 0) {
      console.log(`[SessionManager] Hibernated ${hibernatedCount} inactive sessions`);
    }
  }

  /**
   * Get or create a session for a user
   */
  async getSession(userId: number): Promise<ClaudeTmuxSession> {
    let session = this.sessions.get(userId);

    // Session exists but hibernated (not active but has session ID)
    if (session && !session.isActive() && session.getClaudeSessionId()) {
      console.log(`[SessionManager] Waking up hibernated session for user ${userId}...`);
      await session.start(); // Will use --resume with stored session ID
      return session;
    }

    // Session is active
    if (session && session.isActive()) {
      return session;
    }

    // Create new session with user-specific workDir
    const userWorkDir = this.getUserWorkDir(userId);
    session = new ClaudeTmuxSession({
      userId,
      workDir: userWorkDir,
      timeout: 120_000,
    });
    console.log(`[SessionManager] Creating session for user ${userId} in: ${userWorkDir}`);

    await session.start();
    this.sessions.set(userId, session);

    return session;
  }

  /**
   * Send message for a user
   */
  async chat(userId: number, message: string): Promise<ClaudeMessage> {
    const session = await this.getSession(userId);
    return session.chat(message);
  }

  /**
   * Check if user has active session
   */
  hasSession(userId: number): boolean {
    const session = this.sessions.get(userId);
    return session?.isActive() ?? false;
  }

  /**
   * Stop all sessions
   */
  async stopAll(): Promise<void> {
    console.log(`[SessionManager] Stopping all sessions...`);

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const stopPromises = Array.from(this.sessions.values()).map((s) => s.stop());
    await Promise.all(stopPromises);
    this.sessions.clear();
  }

  /**
   * Stop a specific user's session
   */
  async stopSession(userId: number): Promise<void> {
    const session = this.sessions.get(userId);
    if (session) {
      await session.stop();
      this.sessions.delete(userId);
    }
  }

  /**
   * Get active session count
   */
  getActiveCount(): number {
    return Array.from(this.sessions.values()).filter((s) => s.isActive()).length;
  }
}
