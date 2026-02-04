import React from "react";
import type { SetupFormData } from "../../../hooks/useSetupWizard";

interface ReviewStepProps {
  formData: SetupFormData;
  saveError: string | null;
}

export function ReviewStep({ formData, saveError }: ReviewStepProps) {
  const maskToken = (token: string): string => {
    if (!token) return "(boş)";
    if (token.length <= 10) return "***";
    return token.slice(0, 6) + "..." + token.slice(-4);
  };

  return (
    <div className="setup-step">
      <div className="setup-step-header">
        <h2 className="setup-step-title">Özet</h2>
        <p className="setup-step-description">
          Ayarlarınızı kontrol edin ve kaydedin.
        </p>
      </div>

      <div className="setup-step-content">
        <div className="setup-review">
          <div className="setup-review-section">
            <h4>Telegram</h4>
            <div className="setup-review-item">
              <span className="setup-review-label">Bot Token:</span>
              <code className="setup-review-value">
                {maskToken(formData.TELEGRAM_BOT_TOKEN)}
              </code>
            </div>
            <div className="setup-review-item">
              <span className="setup-review-label">User ID:</span>
              <code className="setup-review-value">
                {formData.MY_TELEGRAM_ID || "(boş)"}
              </code>
            </div>
          </div>

          <div className="setup-review-section">
            <h4>API Anahtarları</h4>
            <div className="setup-review-item">
              <span className="setup-review-label">Gemini API:</span>
              <code className="setup-review-value">
                {formData.GEMINI_API_KEY
                  ? maskToken(formData.GEMINI_API_KEY)
                  : "(yapılandırılmamış)"}
              </code>
            </div>
          </div>

          <div className="setup-review-section">
            <h4>Gelişmiş Ayarlar</h4>
            <div className="setup-review-item">
              <span className="setup-review-label">Web Port:</span>
              <code className="setup-review-value">
                {formData.WEB_PORT || "3000"}
              </code>
            </div>
            <div className="setup-review-item">
              <span className="setup-review-label">AI Model:</span>
              <code className="setup-review-value">
                {formData.AGENT_MODEL || "claude-opus-4-5-20251101"}
              </code>
            </div>
          </div>
        </div>

        {saveError && (
          <div className="setup-error">
            <span className="setup-error-icon">⚠️</span>
            <span>{saveError}</span>
          </div>
        )}

        <div className="setup-note" style={{ marginTop: "1.5rem" }}>
          <span className="setup-note-icon">✨</span>
          <span>
            Kaydet butonuna tıkladığınızda <code>.env</code> dosyası oluşturulacak
            ve uygulama yeniden başlatılacak.
          </span>
        </div>
      </div>
    </div>
  );
}
