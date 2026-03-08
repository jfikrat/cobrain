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
        <h2 className="setup-step-title">Gemini API (Optional)</h2>
        <p className="setup-step-description">
          Gemini API is used for voice message transcription. You can skip this
          step.
        </p>
      </div>

      <div className="setup-step-content">
        <div className="setup-info-box">
          <h4>How to Get a Gemini API Key?</h4>
          <ol>
            <li>
              Go to{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google AI Studio
              </a>
            </li>
            <li>Sign in with your Google account</li>
            <li>Click the "Create API Key" button</li>
            <li>Copy the generated key</li>
          </ol>
        </div>

        <TextInput
          label="Gemini API Key"
          type="password"
          placeholder="AIzaSy..."
          hint="Required for voice messages. You can leave this empty."
          value={formData.GEMINI_API_KEY}
          onChange={(e) => onFieldChange("GEMINI_API_KEY", e.target.value)}
          error={errors.GEMINI_API_KEY}
          autoFocus
        />

        <div className="setup-note">
          <span className="setup-note-icon">💡</span>
          <span>
            This field is optional. You can leave it empty if you won't be
            sending voice messages.
          </span>
        </div>
      </div>
    </div>
  );
}
