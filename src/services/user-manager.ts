/**
 * UserManager - Per-user folder and database management
 * Cobrain v0.2
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { UserMemory } from "../memory/sqlite.ts";
import type { User, UserSettings, UserStats, DEFAULT_USER_SETTINGS } from "../types/user.ts";

export class UserManager {
  private globalDb: Database;
  private userDbs: Map<number, Database> = new Map();
  private userMemories: Map<number, UserMemory> = new Map();
  private basePath: string;

  constructor() {
    this.basePath = config.COBRAIN_BASE_PATH;
    this.globalDb = this.initGlobalDb();
  }

  private initGlobalDb(): Database {
    // Ensure base directory exists
    if (!existsSync(this.basePath)) {
      Bun.spawnSync(["mkdir", "-p", this.basePath]);
    }

    const dbPath = join(this.basePath, "cobrain.db");
    const db = new Database(dbPath, { create: true });

    // Users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME,
        folder_path TEXT NOT NULL,
        settings TEXT DEFAULT '{}'
      )
    `);

    // Scheduled tasks (for autonomous operations)
    db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        config TEXT DEFAULT '{}',
        enabled INTEGER DEFAULT 1,
        last_run_at DATETIME,
        next_run_at DATETIME,
        running_since DATETIME DEFAULT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Task queue (for background processing)
    db.run(`
      CREATE TABLE IF NOT EXISTS task_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        error TEXT,
        source_key TEXT DEFAULT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status, priority DESC)`);

    return db;
  }

  /**
   * Ensure user exists and return user info
   */
  async ensureUser(userId: number): Promise<User> {
    // Check if user exists
    const existing = this.globalDb
      .query<{ id: number; created_at: string; last_seen_at: string; folder_path: string; settings: string }, [number]>(
        "SELECT * FROM users WHERE id = ?"
      )
      .get(userId);

    if (existing) {
      // Update last_seen_at
      this.globalDb.run("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?", [userId]);

      return {
        id: existing.id,
        createdAt: existing.created_at,
        lastSeenAt: new Date().toISOString(),
        folderPath: existing.folder_path,
        settings: JSON.parse(existing.settings || "{}"),
      };
    }

    // Create new user
    const folderPath = join(this.basePath, "users", userId.toString());

    // Create user folder structure
    await mkdir(join(folderPath, "uploads"), { recursive: true });
    await mkdir(join(folderPath, "agent"), { recursive: true });

    // Create CLAUDE.md for this user's Claude session
    await this.createUserClaudeMd(folderPath, userId);

    // Insert user record
    this.globalDb.run(
      `INSERT INTO users (id, folder_path, last_seen_at, settings) VALUES (?, ?, CURRENT_TIMESTAMP, '{}')`,
      [userId, folderPath]
    );

    // Initialize user database
    await this.initUserDb(userId, folderPath);

    console.log(`[UserManager] Yeni kullanıcı oluşturuldu: ${userId}`);

    return {
      id: userId,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      folderPath,
      settings: {},
    };
  }

  /**
   * Get user folder path and ensure CLAUDE.md exists
   */
  getUserFolder(userId: number): string {
    const folderPath = join(this.basePath, "users", userId.toString());

    // Ensure CLAUDE.md exists (for existing users who don't have it)
    const claudeMdPath = join(folderPath, "CLAUDE.md");
    if (!existsSync(claudeMdPath) && existsSync(folderPath)) {
      // Create CLAUDE.md synchronously to avoid race conditions
      this.createUserClaudeMdSync(folderPath, userId);
    }

    return folderPath;
  }

  /**
   * Get or create user-specific database
   */
  async getUserDb(userId: number): Promise<Database> {
    // Check cache
    const cached = this.userDbs.get(userId);
    if (cached) return cached;

    // Ensure user exists
    const user = await this.ensureUser(userId);

    // Open database
    const dbPath = join(user.folderPath, "cobrain.db");
    const db = new Database(dbPath, { create: true });

    // Cache it
    this.userDbs.set(userId, db);

    return db;
  }

  /**
   * Initialize user database schema
   */
  private async initUserDb(userId: number, folderPath: string): Promise<void> {
    const dbPath = join(folderPath, "cobrain.db");
    const db = new Database(dbPath, { create: true });

    // Messages table (no user_id - it's per-user DB)
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Sessions table
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'active',
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      )
    `);

    // Preferences table
    db.run(`
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Goals table
    db.run(`
      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        priority INTEGER DEFAULT 0,
        due_date DATE,
        progress REAL DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      )
    `);

    // Reminders table
    db.run(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT,
        trigger_at DATETIME NOT NULL,
        repeat_pattern TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at)`);

    // Cache the database
    this.userDbs.set(userId, db);
  }

  /**
   * Get user settings
   */
  async getUserSettings(userId: number): Promise<UserSettings> {
    const row = this.globalDb
      .query<{ settings: string }, [number]>("SELECT settings FROM users WHERE id = ?")
      .get(userId);

    return row ? JSON.parse(row.settings || "{}") : {};
  }

  /**
   * Update user settings
   */
  async updateUserSettings(userId: number, settings: Partial<UserSettings>): Promise<void> {
    const current = await this.getUserSettings(userId);
    const merged = { ...current, ...settings };

    this.globalDb.run("UPDATE users SET settings = ? WHERE id = ?", [JSON.stringify(merged), userId]);
  }

  /**
   * Get user statistics
   */
  async getUserStats(userId: number): Promise<UserStats> {
    const db = await this.getUserDb(userId);

    const messageCount =
      db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages").get()?.count ?? 0;

    const sessionCount =
      db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM sessions").get()?.count ?? 0;

    const goalsActive =
      db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM goals WHERE status = 'active'")
        .get()?.count ?? 0;

    const remindersPending =
      db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM reminders WHERE status = 'pending'")
        .get()?.count ?? 0;

    const lastActivity =
      db
        .query<{ created_at: string }, []>("SELECT created_at FROM messages ORDER BY id DESC LIMIT 1")
        .get()?.created_at ?? null;

    // Memory count will be added in Phase 2
    const memoryCount = 0;

    return {
      messageCount,
      sessionCount,
      memoryCount,
      goalsActive,
      remindersPending,
      lastActivity,
    };
  }

  /**
   * Get or create UserMemory for a specific user (sync version for WebSocket handlers)
   */
  getUserMemory(userId: number): UserMemory {
    let memory = this.userMemories.get(userId);
    if (memory) return memory;

    // Get cached db or create one
    const folderPath = this.getUserFolder(userId);
    const dbPath = join(folderPath, "cobrain.db");

    let db = this.userDbs.get(userId);
    if (!db) {
      db = new Database(dbPath, { create: true });
      this.userDbs.set(userId, db);
    }

    memory = new UserMemory(db);
    this.userMemories.set(userId, memory);

    return memory;
  }

  /**
   * Get all users
   */
  getAllUsers(): User[] {
    const rows = this.globalDb
      .query<{ id: number; created_at: string; last_seen_at: string; folder_path: string; settings: string }, []>(
        "SELECT * FROM users ORDER BY last_seen_at DESC"
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      folderPath: row.folder_path,
      settings: JSON.parse(row.settings || "{}"),
    }));
  }

  /**
   * Create CLAUDE.md for user's Claude session
   */
  private async createUserClaudeMd(folderPath: string, userId: number): Promise<void> {
    const claudeMdPath = join(folderPath, "CLAUDE.md");
    const claudeMdContent = `# Sen Cobrain'sin

Sen **Cobrain** adında kişisel bir AI asistansın. Kullanıcı seninle Telegram üzerinden konuşuyor.

## Kimliğin

- Adın: Cobrain
- Kendini asla "Claude" olarak tanıtma, sen "Cobrain"sin
- Samimi, yardımsever ve pratik bir asistansın
- Kullanıcının kişisel asistanısın, ona "sen" diye hitap et

## İletişim

- Türkçe konuş (teknik terimler İngilizce olabilir)
- Kısa ve öz yanıtlar ver (Telegram için optimize)
- Tablolar yerine liste formatı kullan (Telegram tabloları desteklemiyor)
- Kod için \`\`\` kullan

## Yeteneklerin

- **Google Drive**: rclone ile dosya listele, indir, yükle, link oluştur
  - \`rclone lsf gdrive:\` - Dosyaları listele
  - \`rclone link gdrive:path/file\` - Paylaşılabilir link
  - \`rclone copy file gdrive:folder/\` - Yükle
- **Dosya işlemleri**: Okuma, yazma, düzenleme
- **Kod**: Yazma, debug, açıklama
- **Araştırma**: Web araması, bilgi toplama

## Kurallar

1. Kullanıcının dosyalarına dikkat et, izinsiz silme yapma
2. Hassas bilgileri (şifre, token) loglama
3. Emin olmadığında sor
`;

    await Bun.write(claudeMdPath, claudeMdContent);
    console.log(`[UserManager] CLAUDE.md oluşturuldu: ${claudeMdPath}`);
  }

  /**
   * Create CLAUDE.md synchronously (for existing users)
   */
  private createUserClaudeMdSync(folderPath: string, userId: number): void {
    const claudeMdPath = join(folderPath, "CLAUDE.md");
    const claudeMdContent = `# Sen Cobrain'sin

Sen **Cobrain** adında kişisel bir AI asistansın. Kullanıcı seninle Telegram üzerinden konuşuyor.

## Kimliğin

- Adın: Cobrain
- Kendini asla "Claude" olarak tanıtma, sen "Cobrain"sin
- Samimi, yardımsever ve pratik bir asistansın
- Kullanıcının kişisel asistanısın, ona "sen" diye hitap et

## İletişim

- Türkçe konuş (teknik terimler İngilizce olabilir)
- Kısa ve öz yanıtlar ver (Telegram için optimize)
- Tablolar yerine liste formatı kullan (Telegram tabloları desteklemiyor)
- Kod için \`\`\` kullan

## Yeteneklerin

- **Google Drive**: rclone ile dosya listele, indir, yükle, link oluştur
  - \`rclone lsf gdrive:\` - Dosyaları listele
  - \`rclone link gdrive:path/file\` - Paylaşılabilir link
  - \`rclone copy file gdrive:folder/\` - Yükle
- **Dosya işlemleri**: Okuma, yazma, düzenleme
- **Kod**: Yazma, debug, açıklama
- **Araştırma**: Web araması, bilgi toplama

## Kurallar

1. Kullanıcının dosyalarına dikkat et, izinsiz silme yapma
2. Hassas bilgileri (şifre, token) loglama
3. Emin olmadığında sor
`;

    writeFileSync(claudeMdPath, claudeMdContent, "utf-8");
    console.log(`[UserManager] CLAUDE.md oluşturuldu (sync): ${claudeMdPath}`);
  }

  /**
   * Close all database connections
   */
  close(): void {
    for (const db of this.userDbs.values()) {
      db.close();
    }
    this.userDbs.clear();
    this.globalDb.close();
  }
}

// Singleton instance
export const userManager = new UserManager();
