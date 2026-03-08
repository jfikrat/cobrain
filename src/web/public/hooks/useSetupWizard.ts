import { useState, useCallback, useEffect } from "react";

export interface SetupFormData {
  // Required
  TELEGRAM_BOT_TOKEN: string;
  MY_TELEGRAM_ID: string;

  // Optional
  GEMINI_API_KEY: string;
  WEB_PORT: string;
  AGENT_MODEL: string;
}

export interface SetupSchema {
  required: Array<{
    key: string;
    label: string;
    hint: string;
    type: "text" | "password";
  }>;
  optional: Array<{
    key: string;
    label: string;
    hint: string;
    type: "text" | "password";
    default: string;
  }>;
}

export interface SetupState {
  step: number;
  formData: SetupFormData;
  errors: Record<string, string>;
  schema: SetupSchema | null;
  loading: boolean;
  saving: boolean;
  saveError: string | null;
}

const STORAGE_KEY = "cobrain_setup_draft";

const initialFormData: SetupFormData = {
  TELEGRAM_BOT_TOKEN: "",
  MY_TELEGRAM_ID: "",
  GEMINI_API_KEY: "",
  WEB_PORT: "3000",
  AGENT_MODEL: "claude-opus-4-6",
};

export function useSetupWizard() {
  const [state, setState] = useState<SetupState>({
    step: 0,
    formData: initialFormData,
    errors: {},
    schema: null,
    loading: true,
    saving: false,
    saveError: null,
  });

  // Load schema and existing values on mount
  useEffect(() => {
    async function loadSetupStatus() {
      try {
        const response = await fetch("/api/setup/status");
        const data = await response.json();

        // Load from localStorage first (draft)
        const savedDraft = localStorage.getItem(STORAGE_KEY);
        let draftData: Partial<SetupFormData> = {};
        if (savedDraft) {
          try {
            draftData = JSON.parse(savedDraft);
          } catch {
            // Invalid JSON, ignore
          }
        }

        // Merge: defaults < existing .env values < localStorage draft
        const mergedData: SetupFormData = {
          ...initialFormData,
          ...data.existingValues,
          ...draftData,
        };

        setState((prev) => ({
          ...prev,
          schema: data.schema,
          formData: mergedData,
          loading: false,
        }));
      } catch (err) {
        console.error("Failed to load setup status:", err);
        setState((prev) => ({
          ...prev,
          loading: false,
        }));
      }
    }

    loadSetupStatus();
  }, []);

  // Save to localStorage on form data change
  useEffect(() => {
    if (!state.loading) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.formData));
    }
  }, [state.formData, state.loading]);

  const setField = useCallback(
    (key: keyof SetupFormData, value: string) => {
      setState((prev) => ({
        ...prev,
        formData: { ...prev.formData, [key]: value },
        errors: { ...prev.errors, [key]: "" },
      }));
    },
    []
  );

  const validateStep = useCallback((step: number, formData: SetupFormData): Record<string, string> => {
    const errors: Record<string, string> = {};

    if (step === 0) {
      // Telegram step
      if (!formData.TELEGRAM_BOT_TOKEN.trim()) {
        errors.TELEGRAM_BOT_TOKEN = "Bot token is required";
      } else if (!formData.TELEGRAM_BOT_TOKEN.includes(":")) {
        errors.TELEGRAM_BOT_TOKEN = "Invalid token format";
      }

      if (!formData.MY_TELEGRAM_ID.trim()) {
        errors.MY_TELEGRAM_ID = "User ID is required";
      } else if (!/^\d+$/.test(formData.MY_TELEGRAM_ID)) {
        errors.MY_TELEGRAM_ID = "User ID must be numeric only";
      }
    }

    // Step 1 (API Key) - optional, no validation needed
    // Step 2 (Optional) - optional, no validation needed

    return errors;
  }, []);

  const nextStep = useCallback(() => {
    const errors = validateStep(state.step, state.formData);

    if (Object.keys(errors).length > 0) {
      setState((prev) => ({ ...prev, errors }));
      return false;
    }

    setState((prev) => ({
      ...prev,
      step: Math.min(prev.step + 1, 3),
      errors: {},
    }));
    return true;
  }, [state.step, state.formData, validateStep]);

  const prevStep = useCallback(() => {
    setState((prev) => ({
      ...prev,
      step: Math.max(prev.step - 1, 0),
      errors: {},
    }));
  }, []);

  const goToStep = useCallback((step: number) => {
    // Only allow going back or to current step
    setState((prev) => ({
      ...prev,
      step: Math.min(step, prev.step),
      errors: {},
    }));
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    setState((prev) => ({ ...prev, saving: true, saveError: null }));

    try {
      const response = await fetch("/api/setup/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.formData),
      });

      const data = await response.json();

      if (!data.success) {
        setState((prev) => ({
          ...prev,
          saving: false,
          saveError: data.error || "Save failed",
        }));
        return false;
      }

      // Clear draft from localStorage
      localStorage.removeItem(STORAGE_KEY);

      setState((prev) => ({ ...prev, saving: false }));
      return true;
    } catch (err) {
      console.error("Save error:", err);
      setState((prev) => ({
        ...prev,
        saving: false,
        saveError: "Connection error",
      }));
      return false;
    }
  }, [state.formData]);

  const restart = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/setup/restart", {
        method: "POST",
      });

      const data = await response.json();
      return data.success;
    } catch {
      return false;
    }
  }, []);

  return {
    ...state,
    setField,
    nextStep,
    prevStep,
    goToStep,
    save,
    restart,
  };
}
