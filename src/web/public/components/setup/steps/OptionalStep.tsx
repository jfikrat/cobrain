import React from "react";
import { TextInput } from "../../ui/TextInput";
import type { SetupFormData } from "../../../hooks/useSetupWizard";

interface OptionalStepProps {
  formData: SetupFormData;
  errors: Record<string, string>;
  onFieldChange: (key: keyof SetupFormData, value: string) => void;
}

export function OptionalStep({
  formData,
  errors,
  onFieldChange,
}: OptionalStepProps) {
  return (
    <div className="setup-step">
      <div className="setup-step-header">
        <h2 className="setup-step-title">Gelişmiş Ayarlar</h2>
        <p className="setup-step-description">
          Bu ayarlar varsayılan değerlerle çalışır. Değiştirmeniz gerekmez.
        </p>
      </div>

      <div className="setup-step-content">
        <TextInput
          label="Web Arayüzü Portu"
          type="text"
          placeholder="3000"
          hint="Web arayüzünün çalışacağı port"
          value={formData.WEB_PORT}
          onChange={(e) => onFieldChange("WEB_PORT", e.target.value)}
          error={errors.WEB_PORT}
          autoFocus
        />

        <TextInput
          label="AI Model"
          type="text"
          placeholder="claude-opus-4-6"
          hint="Kullanılacak Claude modeli"
          value={formData.AGENT_MODEL}
          onChange={(e) => onFieldChange("AGENT_MODEL", e.target.value)}
          error={errors.AGENT_MODEL}
        />

        <div className="setup-note">
          <span className="setup-note-icon">ℹ️</span>
          <span>
            Bu ayarları daha sonra <code>.env</code> dosyasından
            değiştirebilirsiniz.
          </span>
        </div>
      </div>
    </div>
  );
}
