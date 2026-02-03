#!/usr/bin/env bun
/**
 * Cobrain v0.2 Migration Script
 * Migrates from single DB to per-user folder structure
 *
 * Usage:
 *   bun run scripts/migrate-v02.ts           # Dry run (preview)
 *   bun run scripts/migrate-v02.ts --execute # Actually migrate
 *   bun run scripts/migrate-v02.ts --rollback # Rollback (if backup exists)
 */

import { Database } from "bun:sqlite";
import { existsSync, copyFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Configuration
const OLD_DB_PATH = process.env.DB_PATH || "./data/cobrain.db";
const NEW_BASE_PATH = process.env.COBRAIN_BASE_PATH || join(homedir(), ".cobrain");
const BACKUP_SUFFIX = ".backup-v01";

interface MigrationStats {
  usersFound: number;
  messagesMigrated: number;
  sessionsMigrated: number;
  preferencesMigrated: number;
  errors: string[];
}

const args = process.argv.slice(2);
const isDryRun = !args.includes("--execute");
const isRollback = args.includes("--rollback");

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Cobrain v0.2 Migration Script                      ║
╠══════════════════════════════════════════════════════════════╣
║  Old DB:    ${OLD_DB_PATH.padEnd(47)}║
║  New Base:  ${NEW_BASE_PATH.padEnd(47)}║
║  Mode:      ${(isDryRun ? "DRY RUN (preview)" : isRollback ? "ROLLBACK" : "EXECUTE").padEnd(47)}║
╚══════════════════════════════════════════════════════════════╝
`);

async function main() {
  if (isRollback) {
    await rollback();
    return;
  }

  // Check if old DB exists
  if (!existsSync(OLD_DB_PATH)) {
    console.log("⚠️  Eski veritabanı bulunamadı. Migration gerekli değil.");
    console.log(`   Beklenen: ${OLD_DB_PATH}`);
    process.exit(0);
  }

  // Check if already migrated
  const globalDbPath = join(NEW_BASE_PATH, "cobrain.db");
  if (existsSync(globalDbPath)) {
    console.log("⚠️  Migration zaten yapılmış görünüyor.");
    console.log(`   Global DB mevcut: ${globalDbPath}`);
    console.log("   --rollback ile geri alabilirsiniz.");
    process.exit(1);
  }

  const stats = await migrate();

  console.log(`
═══════════════════════════════════════════════════════════════
📊 Migration Özeti
═══════════════════════════════════════════════════════════════
  Kullanıcılar:    ${stats.usersFound}
  Mesajlar:        ${stats.messagesMigrated}
  Oturumlar:       ${stats.sessionsMigrated}
  Tercihler:       ${stats.preferencesMigrated}
  Hatalar:         ${stats.errors.length}
`);

  if (stats.errors.length > 0) {
    console.log("❌ Hatalar:");
    stats.errors.forEach((e) => console.log(`   - ${e}`));
  }

  if (isDryRun) {
    console.log(`
🔵 DRY RUN - Hiçbir değişiklik yapılmadı.
   Gerçek migration için: bun run scripts/migrate-v02.ts --execute
`);
  } else {
    console.log(`
✅ Migration tamamlandı!
   Yedek: ${OLD_DB_PATH}${BACKUP_SUFFIX}
   Yeni yapı: ${NEW_BASE_PATH}/
`);
  }
}

async function migrate(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    usersFound: 0,
    messagesMigrated: 0,
    sessionsMigrated: 0,
    preferencesMigrated: 0,
    errors: [],
  };

  try {
    // Open old database
    const oldDb = new Database(OLD_DB_PATH, { readonly: true });

    // Get all unique user IDs
    const users = oldDb
      .query<{ user_id: number }, []>("SELECT DISTINCT user_id FROM messages UNION SELECT user_id FROM sessions")
      .all();

    stats.usersFound = users.length;
    console.log(`\n📋 ${users.length} kullanıcı bulundu\n`);

    if (!isDryRun) {
      // Create backup
      const backupPath = `${OLD_DB_PATH}${BACKUP_SUFFIX}`;
      console.log(`💾 Yedek alınıyor: ${backupPath}`);
      copyFileSync(OLD_DB_PATH, backupPath);

      // Create new directory structure
      mkdirSync(NEW_BASE_PATH, { recursive: true });

      // Create global database
      const globalDb = new Database(join(NEW_BASE_PATH, "cobrain.db"), { create: true });
      initGlobalDb(globalDb);

      // Migrate each user
      for (const { user_id } of users) {
        console.log(`\n👤 User ${user_id} migrate ediliyor...`);

        const userFolder = join(NEW_BASE_PATH, "users", user_id.toString());
        mkdirSync(join(userFolder, "uploads"), { recursive: true });
        mkdirSync(join(userFolder, "agent"), { recursive: true });

        // Create user entry in global DB
        globalDb.run(
          "INSERT INTO users (id, folder_path, last_seen_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
          [user_id, userFolder]
        );

        // Create per-user database
        const userDb = new Database(join(userFolder, "cobrain.db"), { create: true });
        initUserDb(userDb);

        // Migrate messages
        const messages = oldDb
          .query<{ role: string; content: string; created_at: string }, [number]>(
            "SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY id"
          )
          .all(user_id);

        for (const msg of messages) {
          userDb.run(
            "INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)",
            [msg.role, msg.content, msg.created_at]
          );
          stats.messagesMigrated++;
        }
        console.log(`   ✓ ${messages.length} mesaj`);

        // Migrate session
        const session = oldDb
          .query<{ session_id: string; created_at: string; last_used_at: string }, [number]>(
            "SELECT session_id, created_at, last_used_at FROM sessions WHERE user_id = ?"
          )
          .get(user_id);

        if (session) {
          userDb.run(
            "INSERT INTO sessions (id, status, created_at, last_used_at) VALUES (?, 'active', ?, ?)",
            [session.session_id, session.created_at, session.last_used_at]
          );
          stats.sessionsMigrated++;
          console.log(`   ✓ 1 oturum`);
        }

        // Migrate preferences
        const prefs = oldDb
          .query<{ data: string }, [number]>("SELECT data FROM preferences WHERE user_id = ?")
          .get(user_id);

        if (prefs) {
          try {
            const prefsData = JSON.parse(prefs.data);
            for (const [key, value] of Object.entries(prefsData)) {
              userDb.run(
                "INSERT INTO preferences (key, value) VALUES (?, ?)",
                [key, JSON.stringify(value)]
              );
              stats.preferencesMigrated++;
            }
            console.log(`   ✓ ${Object.keys(prefsData).length} tercih`);
          } catch (e) {
            stats.errors.push(`User ${user_id} preferences parse error: ${e}`);
          }
        }

        userDb.close();
      }

      globalDb.close();
    } else {
      // Dry run - just count
      for (const { user_id } of users) {
        const msgCount = oldDb
          .query<{ count: number }, [number]>("SELECT COUNT(*) as count FROM messages WHERE user_id = ?")
          .get(user_id)?.count ?? 0;

        const hasSession = oldDb
          .query<{ count: number }, [number]>("SELECT COUNT(*) as count FROM sessions WHERE user_id = ?")
          .get(user_id)?.count ?? 0;

        const prefs = oldDb
          .query<{ data: string }, [number]>("SELECT data FROM preferences WHERE user_id = ?")
          .get(user_id);

        let prefCount = 0;
        if (prefs) {
          try {
            prefCount = Object.keys(JSON.parse(prefs.data)).length;
          } catch {}
        }

        console.log(`   User ${user_id}: ${msgCount} mesaj, ${hasSession} oturum, ${prefCount} tercih`);

        stats.messagesMigrated += msgCount;
        stats.sessionsMigrated += hasSession;
        stats.preferencesMigrated += prefCount;
      }
    }

    oldDb.close();
  } catch (error) {
    stats.errors.push(`Migration error: ${error}`);
  }

  return stats;
}

async function rollback(): Promise<void> {
  const backupPath = `${OLD_DB_PATH}${BACKUP_SUFFIX}`;

  if (!existsSync(backupPath)) {
    console.log("❌ Yedek dosyası bulunamadı. Rollback yapılamıyor.");
    console.log(`   Beklenen: ${backupPath}`);
    process.exit(1);
  }

  if (!existsSync(NEW_BASE_PATH)) {
    console.log("⚠️  Yeni yapı bulunamadı. Rollback gerekli değil.");
    process.exit(0);
  }

  console.log("🔄 Rollback başlıyor...\n");

  if (!isDryRun) {
    // Remove new structure
    console.log(`🗑️  Siliniyor: ${NEW_BASE_PATH}`);
    rmSync(NEW_BASE_PATH, { recursive: true, force: true });

    // Restore backup
    console.log(`📦 Restore ediliyor: ${backupPath} -> ${OLD_DB_PATH}`);
    copyFileSync(backupPath, OLD_DB_PATH);
    rmSync(backupPath);

    console.log("\n✅ Rollback tamamlandı!");
  } else {
    console.log("🔵 DRY RUN - Rollback yapılacak işlemler:");
    console.log(`   - ${NEW_BASE_PATH} silinecek`);
    console.log(`   - ${backupPath} -> ${OLD_DB_PATH} restore edilecek`);
    console.log("\n   Gerçek rollback için: bun run scripts/migrate-v02.ts --rollback --execute");
  }
}

function initGlobalDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME,
      folder_path TEXT NOT NULL,
      settings TEXT DEFAULT '{}'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      schedule TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      last_run_at DATETIME,
      next_run_at DATETIME
    )
  `);

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
      error TEXT
    )
  `);
}

function initUserDb(db: Database): void {
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

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'active',
      message_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
}

main().catch((e) => {
  console.error("❌ Migration hatası:", e);
  process.exit(1);
});
