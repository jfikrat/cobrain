import React from "react";
import { TextInput } from "../../ui/TextInput";
import type { SetupFormData } from "../../../hooks/useSetupWizard";

interface TelegramStepProps {
  formData: SetupFormData;
  errors: Record<string, string>;
  onFieldChange: (key: keyof SetupFormData, value: string) => void;
}

export function TelegramStep({
  formData,
  errors,
  onFieldChange,
}: TelegramStepProps) {
  return (
    <div className="setup-step">
      <div className="setup-step-header">
        <h2 className="setup-step-title">Telegram Botu</h2>
        <p className="setup-step-description">
          Cobrain, Telegram üzerinden sizinle iletişim kurar. Bunun için bir bot
          oluşturmanız gerekiyor.
        </p>
      </div>

      <div className="setup-step-content">
        <div className="setup-info-box">
          <h4>Bot Nasıl Oluşturulur?</h4>
          <ol>
            <li>
              Telegram'da <code>@BotFather</code>'a mesaj atın
            </li>
            <li>
              <code>/newbot</code> komutunu gönderin
            </li>
            <li>Bot için bir isim ve kullanıcı adı belirleyin</li>
            <li>
              Size verilen token'ı kopyalayın (örn:{" "}
              <code>123456789:ABCdefGHI...</code>)
            </li>
          </ol>
        </div>

        <TextInput
          label="Bot Token"
          type="password"
          placeholder="123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ"
          hint="@BotFather'dan aldığınız token"
          value={formData.TELEGRAM_BOT_TOKEN}
          onChange={(e) => onFieldChange("TELEGRAM_BOT_TOKEN", e.target.value)}
          error={errors.TELEGRAM_BOT_TOKEN}
          required
          autoFocus
        />

        <div className="setup-info-box" style={{ marginTop: "1.5rem" }}>
          <h4>User ID Nasıl Bulunur?</h4>
          <ol>
            <li>
              Telegram'da <code>@userinfobot</code>'a mesaj atın
            </li>
            <li>Bot size User ID'nizi gösterecek</li>
          </ol>
        </div>

        <TextInput
          label="Telegram User ID"
          type="text"
          placeholder="421261297"
          hint="Sadece bu ID'den gelen mesajlar işlenir (güvenlik)"
          value={formData.MY_TELEGRAM_ID}
          onChange={(e) => onFieldChange("MY_TELEGRAM_ID", e.target.value)}
          error={errors.MY_TELEGRAM_ID}
          required
        />
      </div>
    </div>
  );
}
