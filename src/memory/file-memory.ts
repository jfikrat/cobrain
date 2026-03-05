/**
 * FileMemory — Markdown-based long-term memory.
 *
 * Two files:
 *   facts.md  — permanent facts/preferences (section-based, overwrite)
 *   events.md — dated event log (append, 90-day TTL)
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

  // ── Facts (kalıcı gerçekler/tercihler) ──────────────────────────────────

  /**
   * Store a fact under a section heading. Creates or overwrites the section.
   * section: e.g. "Konum", "Meslek", "Eş"
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

  // ── Events (tarih damgalı olaylar) ──────────────────────────────────────

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
   * Archive events older than daysOld (default 90).
   * Returns number of archived date sections.
   */
  async archiveOldEvents(daysOld = 90): Promise<number> {
    const content = await this.readFile(this.eventsPath);
    if (!content) return 0;

    const cutoff = daysAgo(daysOld);
    const sections = splitBySections(content);

    const keep: string[] = [];
    const archive: string[] = [];

    for (const section of sections) {
      const match = section.match(/^## (\d{4}-\d{2}-\d{2})/);
      if (match && match[1]! < cutoff) {
        archive.push(section);
      } else {
        keep.push(section);
      }
    }

    if (archive.length === 0) return 0;

    // Write keep back
    await this.atomicWrite(this.eventsPath, keep.join("\n\n").trim() + "\n");

    // Append to monthly archive file
    const archiveMonth = archive[0]!.match(/^## (\d{4}-\d{2})/)?.[1] ?? today().slice(0, 7);
    const archivePath = join(this.archiveDir, `${archiveMonth}-events.md`);
    const existing = await this.readFile(archivePath);
    await this.atomicWrite(archivePath, (existing ? existing + "\n\n" : "") + archive.join("\n\n").trim() + "\n");

    return archive.length;
  }

  // ── Combined read ────────────────────────────────────────────────────────

  async readAll(eventDays = 30): Promise<string> {
    const facts = await this.readFacts();
    const events = await this.readRecentEvents(eventDays);
    const parts: string[] = [];
    if (facts) parts.push(`# Gerçekler & Tercihler\n\n${facts}`);
    if (events) parts.push(`# Son Olaylar (${eventDays} gün)\n\n${events}`);
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
