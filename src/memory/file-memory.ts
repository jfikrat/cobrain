/**
 * FileMemory — Markdown-based long-term memory.
 *
 * Two files:
 *   facts.md  — permanent facts/preferences (section-based, overwrite)
 *   events.md — dated event log (append, judgment-based archiving)
 *
 * No DB, no embeddings, no external deps. Cortex can read/edit directly.
 */

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { rename } from "node:fs/promises";

export class FileMemory {
  private memoryDir: string;
  private factsPath: string;
  private eventsPath: string;
  private archiveDir: string;

  constructor(userFolder: string) {
    this.memoryDir = join(userFolder, "memory");
    this.factsPath = join(this.memoryDir, "facts.md");
    this.eventsPath = join(this.memoryDir, "events.md");
    this.archiveDir = join(this.memoryDir, "archive");
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.archiveDir, { recursive: true });
  }

  /** Atomic write: tmpfile + rename */
  private async atomicWrite(path: string, content: string): Promise<void> {
    const tmp = `${path}.tmp.${Date.now()}`;
    await Bun.write(tmp, content);
    await rename(tmp, path);
  }

  // ── Facts (persistent facts/preferences) ──────────────────────────────────

  /**
   * Store a fact under a section heading. Creates or overwrites the section.
   * section: e.g. "Location", "Career", "Spouse"
   */
  async storeFact(section: string, content: string): Promise<void> {
    const date = today();
    const entry = `## ${section}\n${content} (${date})\n`;

    let existing = await this.readFile(this.factsPath);
    const sectionHeader = `## ${section}`;
    const idx = existing.indexOf(sectionHeader);

    if (idx === -1) {
      // Append new section
      existing = existing ? existing.trimEnd() + "\n\n" + entry : entry;
    } else {
      // Replace existing section (up to next ## or EOF)
      const afterHeader = existing.indexOf("\n## ", idx + 1);
      if (afterHeader === -1) {
        existing = existing.slice(0, idx) + entry;
      } else {
        existing = existing.slice(0, idx) + entry + "\n" + existing.slice(afterHeader + 1);
      }
    }

    await this.atomicWrite(this.factsPath, existing);
  }

  async readFacts(): Promise<string> {
    return this.readFile(this.factsPath);
  }

  // ── Events (date-stamped events) ──────────────────────────────────────

  /**
   * Append an event under today's date heading.
   */
  async logEvent(description: string, date?: string): Promise<void> {
    const d = date ?? today();
    const existing = await this.readFile(this.eventsPath);
    const dayHeader = `## ${d}`;

    let updated: string;
    const idx = existing.indexOf(dayHeader);
    if (idx === -1) {
      // New date section at top
      const newSection = `${dayHeader}\n- ${description}\n`;
      updated = existing ? newSection + "\n" + existing : newSection;
    } else {
      // Append under existing date section
      const lineEnd = existing.indexOf("\n", idx + dayHeader.length);
      const insertAt = lineEnd === -1 ? existing.length : lineEnd + 1;
      updated = existing.slice(0, insertAt) + `- ${description}\n` + existing.slice(insertAt);
    }

    await this.atomicWrite(this.eventsPath, updated);
  }

  /**
   * Read recent events (last N days). Default 30.
   */
  async readRecentEvents(days = 30): Promise<string> {
    const content = await this.readFile(this.eventsPath);
    if (!content) return "";

    const cutoff = daysAgo(days);
    const lines = content.split("\n");
    const result: string[] = [];
    let include = false;

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const datePart = line.slice(3).trim().split(" ")[0] ?? ""; // "2026-02-18"
        include = datePart >= cutoff;
      }
      if (include) result.push(line);
    }

    return result.join("\n").trim();
  }

  /**
   * Archive specific date sections by date strings.
   * Mneme decides which dates to archive — this just executes.
   * Returns number of archived date sections.
   */
  async archiveByDates(dates: string[]): Promise<number> {
    const content = await this.readFile(this.eventsPath);
    if (!content) return 0;

    const dateSet = new Set(dates);
    const sections = splitBySections(content);

    const keep: string[] = [];
    const archive: string[] = [];

    for (const section of sections) {
      const match = section.match(/^## (\d{4}-\d{2}-\d{2})/);
      if (match && dateSet.has(match[1]!)) {
        archive.push(section);
      } else {
        keep.push(section);
      }
    }

    if (archive.length === 0) return 0;

    // Write keep back
    await this.atomicWrite(this.eventsPath, keep.join("\n\n").trim() + "\n");

    // Append to monthly archive files
    for (const section of archive) {
      const month = section.match(/^## (\d{4}-\d{2})/)?.[1] ?? today().slice(0, 7);
      const archivePath = join(this.archiveDir, `${month}-events.md`);
      const existing = await this.readFile(archivePath);
      await this.atomicWrite(archivePath, (existing ? existing + "\n\n" : "") + section.trim() + "\n");
    }

    return archive.length;
  }

  /**
   * Replace an event date section with a consolidated summary.
   * Used by Mneme to merge verbose entries into concise ones.
   */
  async consolidateEvent(date: string, summary: string): Promise<void> {
    const content = await this.readFile(this.eventsPath);
    if (!content) return;

    const sections = splitBySections(content);
    const updated = sections.map(section => {
      const match = section.match(/^## (\d{4}-\d{2}-\d{2})/);
      if (match && match[1] === date) {
        return `## ${date}\n${summary}`;
      }
      return section;
    });

    await this.atomicWrite(this.eventsPath, updated.join("\n\n").trim() + "\n");
  }

  // ── Combined read ────────────────────────────────────────────────────────

  async readAll(eventDays = 30): Promise<string> {
    const facts = await this.readFacts();
    const events = await this.readRecentEvents(eventDays);
    const parts: string[] = [];
    if (facts) parts.push(`# Facts & Preferences\n\n${facts}`);
    if (events) parts.push(`# Recent Events (${eventDays} days)\n\n${events}`);
    return parts.join("\n\n---\n\n");
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async readFile(path: string): Promise<string> {
    if (!existsSync(path)) return "";
    try {
      return await Bun.file(path).text();
    } catch {
      return "";
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function splitBySections(content: string): string[] {
  const parts = content.split(/(?=^## )/m).filter(Boolean);
  return parts.map(s => s.trimEnd());
}
