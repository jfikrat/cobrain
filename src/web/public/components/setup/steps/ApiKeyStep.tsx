import React from "react";
import { TextInput } from "../../ui/TextInput";
import type { SetupFormData } from "../../../hooks/useSetupWizard";

interface ApiKeyStepProps {
  formData: SetupFormData;
  errors: Record<string, string>;
  onFieldChange: (key: keyof SetupFormData, value: string) => void;
}

export function ApiKeyStep({
  formData,
  errors,
  onFieldChange,
}: ApiKeyStepProps) {
  return (
    <div className="setup-step">
      <div className="setup-step-header">
        <h2 className="setup-step-title">Gemini API (Opsiyonel)</h2>
        <p className="setup-step-description">
          Ses mesajlarını yazıya dönüştürmek için Gemini API kullanılır. Bu adımı
          atlayabilirsiniz.
        </p>
      </div>

      <div className="setup-step-content">
        <div className="setup-info-box">
          <h4>Gemini API Key Nasıl Alınır?</h4>
          <ol>
            <li>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google AI Studio
              </a>
              'ya gidin
            </li>
            <li>Google hesabınızla giriş yapın</li>
            <li>"Create API Key" butonuna tıklayın</li>
            <li>Oluşturulan key'i kopyalayın</li>
          </ol>
        </div>

        <TextInput
          label="Gemini API Key"
          type="password"
          placeholder="AIzaSy..."
          hint="Ses mesajları için gerekli. Boş bırakabilirsiniz."
          value={formData.GEMINI_API_KEY}
          onChange={(e) => onFieldChange("GEMINI_API_KEY", e.target.value)}
          error={errors.GEMINI_API_KEY}
          autoFocus
        />

        <div className="setup-note">
          <span className="setup-note-icon">💡</span>
          <span>
            Bu alan opsiyoneldir. Ses mesajı göndermeyecekseniz boş
            bırakabilirsiniz.
          </span>
        </div>
      </div>
    </div>
  );
}
