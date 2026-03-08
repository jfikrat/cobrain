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
        <h2 className="setup-step-title">Telegram Bot</h2>
        <p className="setup-step-description">
          Cobrain communicates with you via Telegram. You need to create a bot
          for this.
        </p>
      </div>

      <div className="setup-step-content">
        <div className="setup-info-box">
          <h4>How to Create a Bot?</h4>
          <ol>
            <li>
              Message <code>@BotFather</code> on Telegram
            </li>
            <li>
              Send the <code>/newbot</code> command
            </li>
            <li>Choose a name and username for the bot</li>
            <li>
              Copy the token you receive (e.g.{" "}
              <code>123456789:ABCdefGHI...</code>)
            </li>
          </ol>
        </div>

        <TextInput
          label="Bot Token"
          type="password"
          placeholder="123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ"
          hint="Token from @BotFather"
          value={formData.TELEGRAM_BOT_TOKEN}
          onChange={(e) => onFieldChange("TELEGRAM_BOT_TOKEN", e.target.value)}
          error={errors.TELEGRAM_BOT_TOKEN}
          required
          autoFocus
        />

        <div className="setup-info-box" style={{ marginTop: "1.5rem" }}>
          <h4>How to Find Your User ID?</h4>
          <ol>
            <li>
              Message <code>@userinfobot</code> on Telegram
            </li>
            <li>The bot will show your User ID</li>
          </ol>
        </div>

        <TextInput
          label="Telegram User ID"
          type="text"
          placeholder="421261297"
          hint="Only messages from this ID will be processed (security)"
          value={formData.MY_TELEGRAM_ID}
          onChange={(e) => onFieldChange("MY_TELEGRAM_ID", e.target.value)}
          error={errors.MY_TELEGRAM_ID}
          required
        />
      </div>
    </div>
  );
}
