/**
 * Persona Tools for Cobrain Agent
 * MCP tools for dynamic persona management
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getPersonaService } from "../../services/persona.ts";
import { toolError, toolSuccess, toolJson } from "../../utils/tool-response.ts";

// ========== PERSONA TOOLS ==========

export const getPersonaTool = (userId: number) =>
  tool("get_persona", "Mevcut persona ayarlarını getir. Kimlik, ses tonu, davranış ve kullanıcı bağlamını içerir.", {}, async () => {
    try {
      const service = await getPersonaService(userId);
      const persona = await service.getActivePersona();
      return toolJson(persona);
    } catch (error) {
      return toolError("Persona getirilemedi", error);
    }
  });

export const updatePersonaTool = (userId: number) =>
  tool(
    "update_persona",
    `Persona alanını güncelle. Bazı alanlar kullanıcı onayı gerektirir.

Auto-approve alanlar (direkt güncellenebilir):
- userContext.* (tercihler, notlar, ilgi alanları)
- behavior.proactivity
- behavior.clarificationThreshold

Onay gerektiren alanlar:
- identity.* (isim, rol)
- voice.* (ton, hitap şekli)
- boundaries.* (sınırlar)`,
    {
      field: z.string().describe("Güncellenecek alan (dot notation, örn: 'voice.tone')"),
      value: z.unknown().describe("Yeni değer"),
      reason: z.string().describe("Güncelleme sebebi"),
    },
    async ({ field, value, reason }) => {
      try {
        const service = await getPersonaService(userId);
        const result = await service.updateField(field, value, reason, "agent");

        if (result.requiresApproval) {
          return toolSuccess(`Bu alan için kullanıcı onayı gerekiyor: ${field}\nÖneri olarak suggest_persona_change kullan.`);
        }

        console.log(`[Persona] Updated ${field} for user ${userId}`);
        return toolSuccess(`Persona güncellendi:\n- Alan: ${field}\n- Yeni değer: ${JSON.stringify(value)}\n- Sebep: ${reason}`);
      } catch (error) {
        return toolError("Persona güncellenemedi", error);
      }
    }
  );

export const suggestPersonaChangeTool = (userId: number) =>
  tool(
    "suggest_persona_change",
    "Persona değişikliği öner. Kullanıcıya onay sorulacak. Kimlik, ton, sınır değişiklikleri için kullan.",
    {
      field: z.string().describe("Değiştirilecek alan (dot notation)"),
      currentValue: z.unknown().describe("Mevcut değer"),
      suggestedValue: z.unknown().describe("Önerilen değer"),
      reason: z.string().describe("Neden bu değişiklik öneriliyor"),
    },
    async ({ field, currentValue, suggestedValue, reason }) => {
      try {
        console.log(`[Persona] Suggestion for user ${userId}: ${field} = ${JSON.stringify(suggestedValue)}`);
        return toolJson({ type: "persona_suggestion", field, currentValue, suggestedValue, reason, userId });
      } catch (error) {
        return toolError("Öneri oluşturulamadı", error);
      }
    }
  );

export const learnUserContextTool = (userId: number) =>
  tool(
    "learn_user_context",
    "Kullanıcı hakkında bilgi öğren ve kaydet. İsim, rol, ilgi alanı, tercih, önemli tarih veya iletişim notu ekle.",
    {
      type: z.enum(["name", "role", "interest", "preference", "date", "note"]).describe("Bilgi türü"),
      key: z.string().describe("Anahtar (preference ve date için gerekli, diğerleri için boş bırakılabilir)"),
      value: z.string().describe("Değer"),
    },
    async ({ type, key, value }) => {
      try {
        const service = await getPersonaService(userId);
        await service.learnUserContext(type, key, value);

        console.log(`[Persona] Learned ${type} for user ${userId}: ${key || value}`);

        const typeLabels: Record<string, string> = {
          name: "Kullanıcı adı",
          role: "Meslek/rol",
          interest: "İlgi alanı",
          preference: "Tercih",
          date: "Önemli tarih",
          note: "İletişim notu",
        };

        return toolSuccess(`${typeLabels[type]} kaydedildi: ${key ? `${key} = ` : ""}${value}`);
      } catch (error) {
        return toolError("Bilgi kaydedilemedi", error);
      }
    }
  );

export const getPersonaHistoryTool = (userId: number) =>
  tool(
    "get_persona_history",
    "Persona değişiklik geçmişini getir.",
    {
      limit: z.number().min(1).max(50).default(10).describe("Maksimum kayıt sayısı"),
    },
    async ({ limit }) => {
      try {
        const service = await getPersonaService(userId);
        const history = await service.getHistory(limit);

        if (history.length === 0) {
          return toolSuccess("Henüz persona değişikliği yok.");
        }

        const formatted = history
          .map((h) => {
            const date = new Date(h.createdAt).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
            const fields = h.changedFields.join(", ");
            return `[${date}] v${h.version} (${h.changeType}): ${fields}\n  Sebep: ${h.reason}`;
          })
          .join("\n\n");

        return toolSuccess(`Persona geçmişi (son ${history.length}):\n\n${formatted}`);
      } catch (error) {
        return toolError("Geçmiş getirilemedi", error);
      }
    }
  );

export const rollbackPersonaTool = (userId: number) =>
  tool(
    "rollback_persona",
    "Persona'yı önceki bir versiyona geri döndür. Kullanıcı onayı gerektirir.",
    {
      targetVersion: z.number().describe("Geri dönülecek versiyon numarası"),
      reason: z.string().describe("Geri dönüş sebebi"),
    },
    async ({ targetVersion, reason }) => {
      try {
        console.log(`[Persona] Rollback request for user ${userId}: v${targetVersion}`);
        return toolJson({ type: "persona_rollback_request", targetVersion, reason, userId });
      } catch (error) {
        return toolError("Rollback isteği oluşturulamadı", error);
      }
    }
  );

export const createSnapshotTool = (userId: number) =>
  tool(
    "create_persona_snapshot",
    "Mevcut persona durumunun snapshot'ını oluştur. Önemli anlar için (100. mesaj, büyük değişiklik öncesi vb.)",
    {
      milestone: z.string().describe("Milestone adı (örn: '100. mesaj', 'ton değişikliği')"),
      notes: z.string().optional().describe("Ek notlar"),
    },
    async ({ milestone, notes }) => {
      try {
        const service = await getPersonaService(userId);
        await service.createSnapshot(milestone, notes);

        console.log(`[Persona] Snapshot created for user ${userId}: ${milestone}`);
        return toolSuccess(`Snapshot oluşturuldu: "${milestone}"`);
      } catch (error) {
        return toolError("Snapshot oluşturulamadı", error);
      }
    }
  );

export const getSnapshotsTool = (userId: number) =>
  tool("get_persona_snapshots", "Kayıtlı persona snapshot'larını listele.", {}, async () => {
    try {
      const service = await getPersonaService(userId);
      const snapshots = await service.getSnapshots();

      if (snapshots.length === 0) {
        return toolSuccess("Henüz snapshot yok.");
      }

      const formatted = snapshots
        .map((s) => {
          const date = new Date(s.createdAt).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
          return `v${s.version} [${date}]: ${s.milestone}${s.notes ? ` - ${s.notes}` : ""}`;
        })
        .join("\n");

      return toolSuccess(`Persona snapshot'ları:\n${formatted}`);
    } catch (error) {
      return toolError("Snapshot'lar getirilemedi", error);
    }
  });

export function createPersonaServer(userId: number) {
  return createSdkMcpServer({
    name: "cobrain-persona",
    version: "1.0.0",
    tools: [
      getPersonaTool(userId),
      updatePersonaTool(userId),
      suggestPersonaChangeTool(userId),
      learnUserContextTool(userId),
      getPersonaHistoryTool(userId),
      rollbackPersonaTool(userId),
      createSnapshotTool(userId),
      getSnapshotsTool(userId),
    ],
  });
}

// ========== Helper for applying approved changes ==========

export async function applyApprovedPersonaChange(userId: number, field: string, value: unknown, reason: string): Promise<boolean> {
  try {
    const service = await getPersonaService(userId);
    const result = await service.updateField(field, value, reason, "user");
    return result.success;
  } catch (error) {
    console.error(`[Persona] Failed to apply approved change:`, error);
    return false;
  }
}

export async function applyApprovedRollback(userId: number, targetVersion: number, reason: string): Promise<boolean> {
  try {
    const service = await getPersonaService(userId);
    const result = await service.rollback(targetVersion, reason);
    return result !== null;
  } catch (error) {
    console.error(`[Persona] Failed to apply rollback:`, error);
    return false;
  }
}
