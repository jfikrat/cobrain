/**
 * Persona type definitions for Cobrain v0.3
 * Dynamic persona system - "yaşayan varlık"
 */

// ===== Core Persona Interface =====

export interface Persona {
  id: number;
  version: number;

  identity: PersonaIdentity;
  voice: PersonaVoice;
  behavior: PersonaBehavior;
  boundaries: PersonaBoundaries;
  userContext: PersonaUserContext;

  // Meta
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface PersonaIdentity {
  name: string; // "Cobrain"
  role: string; // "kişisel AI asistan"
  tagline?: string; // "akıllı ikinci beyin"
  coreValues: string[]; // ["güvenilirlik", "pratiklik"]
}

export interface PersonaVoice {
  tone: PersonaTone;
  formality: number; // 0-1 (0=casual, 1=formal)
  verbosity: number; // 0-1 (0=kısa, 1=detaylı)
  emojiUsage: EmojiUsage;
  language: string; // "tr"
  addressForm: AddressForm;
}

export type PersonaTone = "samimi" | "resmi" | "teknik" | "espirili" | "destekleyici";
export type EmojiUsage = "none" | "minimal" | "moderate" | "frequent";
export type AddressForm = "sen" | "siz";

export interface PersonaBehavior {
  proactivity: number; // 0-1 (ne kadar proaktif)
  clarificationThreshold: number; // 0-1 (ne zaman soru sorar)
  errorHandling: ErrorHandlingStyle;
  responseStyle: ResponseStyle;
}

export type ErrorHandlingStyle = "apologetic" | "matter-of-fact" | "humorous";
export type ResponseStyle = "result-first" | "explanation-first" | "balanced";

export interface PersonaBoundaries {
  topicsToAvoid: string[]; // ["siyaset", "din"]
  alwaysAskPermission: string[]; // ["silme", "gönderim"]
  maxResponseLength: number;
}

export interface PersonaUserContext {
  name: string;
  role?: string;
  interests: string[];
  preferences: Record<string, string>;
  importantDates: Record<string, string>;
  communicationNotes: string[];
}

// ===== Persona Change History =====

export interface PersonaChange {
  id: number;
  personaId: number;
  version: number;
  changeType: PersonaChangeType;
  changedFields: string[]; // ["voice.tone", "behavior.proactivity"]
  previousValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  reason: string;
  triggeredBy: PersonaChangeTrigger;
  createdAt: string;
}

export type PersonaChangeType = "create" | "update" | "evolve" | "rollback";
export type PersonaChangeTrigger = "user" | "agent" | "system";

// ===== Persona Snapshots =====

export interface PersonaSnapshot {
  id: number;
  personaId: number;
  version: number;
  snapshotData: Persona;
  milestone: string;
  notes?: string;
  createdAt: string;
}

// ===== Evolution Triggers =====

export interface EvolutionTrigger {
  id: number;
  triggerType: EvolutionTriggerType;
  triggerData: Record<string, unknown>;
  processed: boolean;
  createdAt: string;
}

export type EvolutionTriggerType = "feedback" | "pattern" | "milestone";

// ===== Field Security Classification =====

/**
 * Fields that agent can modify without user approval
 */
export const AUTO_APPROVE_FIELDS: string[] = [
  "userContext.preferences",
  "userContext.communicationNotes",
  "userContext.interests",
  "userContext.importantDates",
  "behavior.proactivity",
  "behavior.clarificationThreshold",
];

/**
 * Fields that require user approval
 */
export const REQUIRES_APPROVAL_FIELDS: string[] = [
  "identity.name",
  "identity.role",
  "identity.tagline",
  "identity.coreValues",
  "voice.tone",
  "voice.addressForm",
  "voice.formality",
  "voice.verbosity",
  "voice.emojiUsage",
  "boundaries.topicsToAvoid",
  "boundaries.alwaysAskPermission",
  "boundaries.maxResponseLength",
];

// ===== Default Persona =====

export const DEFAULT_PERSONA: Omit<Persona, "id" | "createdAt" | "updatedAt"> = {
  version: 1,
  identity: {
    name: "Cobrain",
    role: "kişisel AI asistan",
    tagline: "akıllı ikinci beyin + pratik asistan",
    coreValues: ["güvenilirlik", "pratiklik", "sakinlik"],
  },
  voice: {
    tone: "samimi",
    formality: 0.3,
    verbosity: 0.5,
    emojiUsage: "none",
    language: "tr",
    addressForm: "sen",
  },
  behavior: {
    proactivity: 0.5,
    clarificationThreshold: 0.6,
    errorHandling: "matter-of-fact",
    responseStyle: "result-first",
  },
  boundaries: {
    topicsToAvoid: [],
    alwaysAskPermission: ["silme", "gönderim"],
    maxResponseLength: 2000,
  },
  userContext: {
    name: "Kullanıcı",
    interests: [],
    preferences: {},
    importantDates: {},
    communicationNotes: [],
  },
  isActive: true,
};

// ===== Helper Types for Updates =====

export interface PersonaUpdateRequest {
  field: string; // dot notation: "voice.tone"
  value: unknown;
  reason?: string;
}

export interface PersonaSuggestion {
  field: string;
  currentValue: unknown;
  suggestedValue: unknown;
  reason: string;
  confidence: number; // 0-1
}

// ===== DB Row Types (for SQLite) =====

export interface PersonaDbRow {
  id: number;
  version: number;
  identity: string; // JSON
  voice: string; // JSON
  behavior: string; // JSON
  boundaries: string; // JSON
  user_context: string; // JSON
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

export interface PersonaHistoryDbRow {
  id: number;
  persona_id: number;
  version: number;
  change_type: string;
  changed_fields: string; // JSON array
  previous_values: string | null; // JSON
  new_values: string; // JSON
  reason: string;
  triggered_by: string;
  created_at: string;
}

export interface PersonaSnapshotDbRow {
  id: number;
  persona_id: number;
  version: number;
  snapshot_data: string; // JSON
  milestone: string;
  notes: string | null;
  created_at: string;
}

export interface EvolutionTriggerDbRow {
  id: number;
  trigger_type: string;
  trigger_data: string; // JSON
  processed: number;
  created_at: string;
}
