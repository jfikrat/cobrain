/**
 * PersonaService - Per-user persona management
 * Cobrain v0.3 - Dynamic Persona System
 */

import type { Database } from "bun:sqlite";
import { userManager } from "./user-manager.ts";
import {
  type Persona,
  type PersonaChange,
  type PersonaSnapshot,
  type PersonaUpdateRequest,
  type PersonaDbRow,
  type PersonaHistoryDbRow,
  type PersonaSnapshotDbRow,
  type PersonaChangeTrigger,
  type PersonaChangeType,
  DEFAULT_PERSONA,
  AUTO_APPROVE_FIELDS,
  REQUIRES_APPROVAL_FIELDS,
} from "../types/persona.ts";

export class PersonaService {
  private userId: number;
  private db: Database | null = null;

  constructor(userId: number) {
    this.userId = userId;
  }

  /**
   * Get database connection (lazy initialization)
   */
  private async getDb(): Promise<Database> {
    if (!this.db) {
      this.db = await userManager.getUserDb(this.userId);
    }
    return this.db;
  }

  /**
   * Initialize persona tables in user database
   */
  async initTables(): Promise<void> {
    const db = await this.getDb();

    // Persona tablosu
    db.run(`
      CREATE TABLE IF NOT EXISTS personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL DEFAULT 1,
        identity TEXT NOT NULL,
        voice TEXT NOT NULL,
        behavior TEXT NOT NULL,
        boundaries TEXT NOT NULL,
        user_context TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_personas_active ON personas(is_active)`);

    // Değişiklik geçmişi
    db.run(`
      CREATE TABLE IF NOT EXISTS persona_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'evolve', 'rollback')),
        changed_fields TEXT NOT NULL,
        previous_values TEXT,
        new_values TEXT NOT NULL,
        reason TEXT NOT NULL,
        triggered_by TEXT NOT NULL CHECK(triggered_by IN ('user', 'agent', 'system')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (persona_id) REFERENCES personas(id)
      )
    `);

    // Snapshot'lar
    db.run(`
      CREATE TABLE IF NOT EXISTS persona_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        snapshot_data TEXT NOT NULL,
        milestone TEXT NOT NULL,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (persona_id) REFERENCES personas(id)
      )
    `);

    // Evolution trigger'ları
    db.run(`
      CREATE TABLE IF NOT EXISTS evolution_triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_type TEXT NOT NULL,
        trigger_data TEXT NOT NULL,
        processed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log(`[PersonaService] Tables initialized for user ${this.userId}`);
  }

  /**
   * Get active persona for user (creates default if none exists)
   */
  async getActivePersona(): Promise<Persona> {
    const db = await this.getDb();

    const row = db
      .query<PersonaDbRow, []>("SELECT * FROM personas WHERE is_active = 1 LIMIT 1")
      .get();

    if (row) {
      return this.rowToPersona(row);
    }

    // Create default persona
    return this.createDefaultPersona();
  }

  /**
   * Get persona by ID
   */
  async getPersonaById(id: number): Promise<Persona | null> {
    const db = await this.getDb();

    const row = db.query<PersonaDbRow, [number]>("SELECT * FROM personas WHERE id = ?").get(id);

    return row ? this.rowToPersona(row) : null;
  }

  /**
   * Get persona by version
   */
  async getPersonaByVersion(version: number): Promise<Persona | null> {
    const db = await this.getDb();

    const row = db
      .query<PersonaDbRow, [number]>("SELECT * FROM personas WHERE version = ? ORDER BY id DESC LIMIT 1")
      .get(version);

    return row ? this.rowToPersona(row) : null;
  }

  /**
   * Create default persona for new user
   */
  private async createDefaultPersona(): Promise<Persona> {
    const db = await this.getDb();

    const now = new Date().toISOString();

    db.run(
      `INSERT INTO personas (version, identity, voice, behavior, boundaries, user_context, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        DEFAULT_PERSONA.version,
        JSON.stringify(DEFAULT_PERSONA.identity),
        JSON.stringify(DEFAULT_PERSONA.voice),
        JSON.stringify(DEFAULT_PERSONA.behavior),
        JSON.stringify(DEFAULT_PERSONA.boundaries),
        JSON.stringify(DEFAULT_PERSONA.userContext),
        now,
      ]
    );

    const id = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;

    // Record creation in history
    await this.recordChange({
      personaId: id,
      version: 1,
      changeType: "create",
      changedFields: ["*"],
      previousValues: {},
      newValues: DEFAULT_PERSONA,
      reason: "İlk persona oluşturuldu",
      triggeredBy: "system",
    });

    console.log(`[PersonaService] Default persona created for user ${this.userId}`);

    return {
      id,
      ...DEFAULT_PERSONA,
      createdAt: now,
      updatedAt: null,
    };
  }

  /**
   * Update specific field(s) of persona
   */
  async updateField(
    field: string,
    value: unknown,
    reason: string,
    triggeredBy: PersonaChangeTrigger = "agent"
  ): Promise<{ success: boolean; requiresApproval: boolean; persona?: Persona }> {
    // Check if approval is required
    const requiresApproval = this.fieldRequiresApproval(field);

    if (requiresApproval && triggeredBy !== "user") {
      return { success: false, requiresApproval: true };
    }

    const persona = await this.getActivePersona();
    const previousValue = this.getNestedValue(persona as unknown as Record<string, unknown>, field);

    // Apply update
    const updatedPersona = this.setNestedValue({ ...persona } as unknown as Record<string, unknown>, field, value) as unknown as Persona;

    // Save to database
    await this.savePersona(updatedPersona, "update", [field], { [field]: previousValue }, { [field]: value }, reason, triggeredBy);

    return { success: true, requiresApproval: false, persona: updatedPersona };
  }

  /**
   * Update multiple fields at once
   */
  async updateFields(
    updates: PersonaUpdateRequest[],
    triggeredBy: PersonaChangeTrigger = "agent"
  ): Promise<{ success: boolean; requiresApproval: string[]; persona?: Persona }> {
    const requiresApproval: string[] = [];

    for (const update of updates) {
      if (this.fieldRequiresApproval(update.field) && triggeredBy !== "user") {
        requiresApproval.push(update.field);
      }
    }

    if (requiresApproval.length > 0) {
      return { success: false, requiresApproval };
    }

    const persona = await this.getActivePersona();
    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const changedFields: string[] = [];

    let updatedPersona = { ...persona };

    for (const update of updates) {
      const previousValue = this.getNestedValue(persona as unknown as Record<string, unknown>, update.field);
      previousValues[update.field] = previousValue;
      newValues[update.field] = update.value;
      changedFields.push(update.field);
      updatedPersona = this.setNestedValue(updatedPersona as unknown as Record<string, unknown>, update.field, update.value) as unknown as Persona;
    }

    const reason = updates.map((u) => u.reason).filter(Boolean).join("; ") || "Çoklu güncelleme";

    await this.savePersona(updatedPersona, "update", changedFields, previousValues, newValues, reason, triggeredBy);

    return { success: true, requiresApproval: [], persona: updatedPersona };
  }

  /**
   * Learn user context (auto-approved)
   */
  async learnUserContext(
    type: "name" | "role" | "interest" | "preference" | "date" | "note",
    key: string,
    value: string
  ): Promise<Persona> {
    const persona = await this.getActivePersona();
    const field = `userContext.${type === "note" ? "communicationNotes" : type === "interest" ? "interests" : type === "preference" ? "preferences" : type === "date" ? "importantDates" : type}`;

    let newValue: unknown;
    let previousValue: unknown;

    switch (type) {
      case "name":
        previousValue = persona.userContext.name;
        newValue = value;
        persona.userContext.name = value;
        break;
      case "role":
        previousValue = persona.userContext.role;
        newValue = value;
        persona.userContext.role = value;
        break;
      case "interest":
        previousValue = [...persona.userContext.interests];
        if (!persona.userContext.interests.includes(value)) {
          persona.userContext.interests.push(value);
        }
        newValue = [...persona.userContext.interests];
        break;
      case "preference":
        previousValue = { ...persona.userContext.preferences };
        persona.userContext.preferences[key] = value;
        newValue = { ...persona.userContext.preferences };
        break;
      case "date":
        previousValue = { ...persona.userContext.importantDates };
        persona.userContext.importantDates[key] = value;
        newValue = { ...persona.userContext.importantDates };
        break;
      case "note":
        previousValue = [...persona.userContext.communicationNotes];
        persona.userContext.communicationNotes.push(value);
        newValue = [...persona.userContext.communicationNotes];
        break;
    }

    await this.savePersona(
      persona,
      "update",
      [field],
      { [field]: previousValue },
      { [field]: newValue },
      `Kullanıcı hakkında bilgi öğrenildi: ${type}`,
      "agent"
    );

    return persona;
  }

  /**
   * Rollback to previous version
   */
  async rollback(targetVersion: number, reason: string): Promise<Persona | null> {
    const db = await this.getDb();

    // Find snapshot or history entry for target version
    const snapshot = db
      .query<PersonaSnapshotDbRow, [number]>("SELECT * FROM persona_snapshots WHERE version = ? ORDER BY id DESC LIMIT 1")
      .get(targetVersion);

    if (snapshot) {
      const snapshotData = JSON.parse(snapshot.snapshot_data) as Persona;
      const currentPersona = await this.getActivePersona();

      // Deactivate current persona
      db.run("UPDATE personas SET is_active = 0 WHERE is_active = 1");

      // Create new persona from snapshot
      const now = new Date().toISOString();
      const newVersion = currentPersona.version + 1;

      db.run(
        `INSERT INTO personas (version, identity, voice, behavior, boundaries, user_context, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          newVersion,
          JSON.stringify(snapshotData.identity),
          JSON.stringify(snapshotData.voice),
          JSON.stringify(snapshotData.behavior),
          JSON.stringify(snapshotData.boundaries),
          JSON.stringify(snapshotData.userContext),
          now,
        ]
      );

      const id = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;

      await this.recordChange({
        personaId: id,
        version: newVersion,
        changeType: "rollback",
        changedFields: ["*"],
        previousValues: currentPersona as unknown as Record<string, unknown>,
        newValues: snapshotData as unknown as Record<string, unknown>,
        reason: `Versiyon ${targetVersion}'e geri dönüldü: ${reason}`,
        triggeredBy: "user",
      });

      return this.getActivePersona();
    }

    return null;
  }

  /**
   * Create snapshot of current persona
   */
  async createSnapshot(milestone: string, notes?: string): Promise<void> {
    const db = await this.getDb();
    const persona = await this.getActivePersona();

    db.run(
      `INSERT INTO persona_snapshots (persona_id, version, snapshot_data, milestone, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [persona.id, persona.version, JSON.stringify(persona), milestone, notes || null]
    );

    console.log(`[PersonaService] Snapshot created: ${milestone}`);
  }

  /**
   * Get change history
   */
  async getHistory(limit: number = 20): Promise<PersonaChange[]> {
    const db = await this.getDb();

    const rows = db
      .query<PersonaHistoryDbRow, [number]>(
        "SELECT * FROM persona_history ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit);

    return rows.map((row) => ({
      id: row.id,
      personaId: row.persona_id,
      version: row.version,
      changeType: row.change_type as PersonaChangeType,
      changedFields: JSON.parse(row.changed_fields),
      previousValues: row.previous_values ? JSON.parse(row.previous_values) : {},
      newValues: JSON.parse(row.new_values),
      reason: row.reason,
      triggeredBy: row.triggered_by as PersonaChangeTrigger,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get snapshots
   */
  async getSnapshots(): Promise<PersonaSnapshot[]> {
    const db = await this.getDb();

    const rows = db
      .query<PersonaSnapshotDbRow, []>("SELECT * FROM persona_snapshots ORDER BY created_at DESC")
      .all();

    return rows.map((row) => ({
      id: row.id,
      personaId: row.persona_id,
      version: row.version,
      snapshotData: JSON.parse(row.snapshot_data),
      milestone: row.milestone,
      notes: row.notes || undefined,
      createdAt: row.created_at,
    }));
  }

  // ===== Private Helpers =====

  private async savePersona(
    persona: Persona,
    changeType: PersonaChangeType,
    changedFields: string[],
    previousValues: Record<string, unknown>,
    newValues: Record<string, unknown>,
    reason: string,
    triggeredBy: PersonaChangeTrigger
  ): Promise<void> {
    const db = await this.getDb();
    const now = new Date().toISOString();

    // Increment version
    persona.version += 1;
    persona.updatedAt = now;

    // Deactivate old persona
    db.run("UPDATE personas SET is_active = 0 WHERE is_active = 1");

    // Insert new version
    db.run(
      `INSERT INTO personas (version, identity, voice, behavior, boundaries, user_context, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        persona.version,
        JSON.stringify(persona.identity),
        JSON.stringify(persona.voice),
        JSON.stringify(persona.behavior),
        JSON.stringify(persona.boundaries),
        JSON.stringify(persona.userContext),
        persona.createdAt,
        now,
      ]
    );

    const newId = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
    persona.id = newId;

    // Record change
    await this.recordChange({
      personaId: newId,
      version: persona.version,
      changeType,
      changedFields,
      previousValues,
      newValues,
      reason,
      triggeredBy,
    });
  }

  private async recordChange(change: Omit<PersonaChange, "id" | "createdAt">): Promise<void> {
    const db = await this.getDb();

    db.run(
      `INSERT INTO persona_history (persona_id, version, change_type, changed_fields, previous_values, new_values, reason, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        change.personaId,
        change.version,
        change.changeType,
        JSON.stringify(change.changedFields),
        JSON.stringify(change.previousValues),
        JSON.stringify(change.newValues),
        change.reason,
        change.triggeredBy,
      ]
    );
  }

  private rowToPersona(row: PersonaDbRow): Persona {
    return {
      id: row.id,
      version: row.version,
      identity: JSON.parse(row.identity),
      voice: JSON.parse(row.voice),
      behavior: JSON.parse(row.behavior),
      boundaries: JSON.parse(row.boundaries),
      userContext: JSON.parse(row.user_context),
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private fieldRequiresApproval(field: string): boolean {
    // Check exact match first
    if (REQUIRES_APPROVAL_FIELDS.includes(field)) return true;
    if (AUTO_APPROVE_FIELDS.includes(field)) return false;

    // Check prefix match (e.g., "identity.name" matches "identity.*")
    const parts = field.split(".");
    if (parts.length > 1) {
      const category = parts[0];
      // Identity and boundaries always require approval
      if (category === "identity" || category === "boundaries") return true;
      // Voice changes require approval except for auto-approve fields
      if (category === "voice") return true;
    }

    return false;
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  private setNestedValue<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
    const parts = path.split(".");
    const result = JSON.parse(JSON.stringify(obj)) as T; // Deep clone
    let current: Record<string, unknown> = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    const lastPart = parts[parts.length - 1]!;
    current[lastPart] = value;
    return result;
  }
}

// ===== Factory function =====

const personaServices = new Map<number, PersonaService>();

export async function getPersonaService(userId: number): Promise<PersonaService> {
  let service = personaServices.get(userId);

  if (!service) {
    service = new PersonaService(userId);
    await service.initTables();
    personaServices.set(userId, service);
  }

  return service;
}
