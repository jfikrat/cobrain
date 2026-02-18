/**
 * Stem Notebook — Persistent scratchpad that survives context resets.
 * Stored as a markdown file in the user's data folder.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_CONTENT = `# Stem Defteri
Güncelleme: ${new Date().toISOString()}

## Aktif Durum
- (henüz bilgi yok)

## Bekleyen İşler
- (yok)

## Bugünkü Olaylar
- (henüz olay yok)

## Öğrenilenler
- (henüz yok)

## Cortex'e Bildirilecekler
- (boş)
`;

// Rough estimate: 1 token ≈ 4 chars for Turkish text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class Notebook {
  private content: string;
  private dirty = false;

  constructor(private filePath: string) {
    this.content = this.loadFromDisk();
  }

  private loadFromDisk(): string {
    try {
      if (existsSync(this.filePath)) {
        return readFileSync(this.filePath, "utf-8");
      }
    } catch (err) {
      console.warn("[Notebook] Failed to load:", err);
    }
    return DEFAULT_CONTENT;
  }

  private saveToDisk(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, this.content, "utf-8");
      this.dirty = false;
    } catch (err) {
      console.warn("[Notebook] Failed to save:", err);
    }
  }

  /** Read the full notebook content */
  read(): string {
    return this.content;
  }

  /** Overwrite a specific section (identified by ## heading) */
  writeSection(heading: string, content: string): void {
    const sectionRegex = new RegExp(
      `(## ${this.escapeRegex(heading)}\n)([\\s\\S]*?)(?=\n## |$)`,
    );
    const match = this.content.match(sectionRegex);
    if (match) {
      this.content = this.content.replace(sectionRegex, `$1${content}\n`);
    } else {
      // Section doesn't exist — append it
      this.content += `\n## ${heading}\n${content}\n`;
    }
    this.dirty = true;
    this.saveToDisk();
  }

  /** Append a line to a specific section */
  appendToSection(heading: string, line: string): void {
    const sectionRegex = new RegExp(
      `(## ${this.escapeRegex(heading)}\n)([\\s\\S]*?)(?=\n## |$)`,
    );
    const match = this.content.match(sectionRegex);
    if (match && match[2] !== undefined) {
      const existingContent = match[2].trimEnd();
      this.content = this.content.replace(
        sectionRegex,
        `$1${existingContent}\n${line}\n`,
      );
    } else {
      this.content += `\n## ${heading}\n${line}\n`;
    }
    this.dirty = true;
    this.saveToDisk();
  }

  /** Get seed content for injecting into system prompt */
  getSeedContent(): string {
    return this.content;
  }

  /** Approximate token count of the notebook */
  estimateTokens(): number {
    return estimateTokens(this.content);
  }

  /** Force flush to disk */
  flush(): void {
    if (this.dirty) {
      this.saveToDisk();
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
