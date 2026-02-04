import React, { useState, useEffect, useCallback } from "react";
import { useSetupWizard } from "../../hooks/useSetupWizard";
import { WizardStepIndicator } from "./WizardStep";
import { TelegramStep } from "./steps/TelegramStep";
import { ApiKeyStep } from "./steps/ApiKeyStep";
import { OptionalStep } from "./steps/OptionalStep";
import { ReviewStep } from "./steps/ReviewStep";
import { Button } from "../ui/Button";
import { BrainIcon } from "../ui/Icons";

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const {
    step,
    formData,
    errors,
    loading,
    saving,
    saveError,
    setField,
    nextStep,
    prevStep,
    goToStep,
    save,
    restart,
  } = useSetupWizard();

  const [restarting, setRestarting] = useState(false);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        // Prevent if inside textarea or button
        const target = e.target as HTMLElement;
        if (target.tagName === "TEXTAREA" || target.tagName === "BUTTON") {
          return;
        }

        if (step < 3) {
          e.preventDefault();
          nextStep();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [step, nextStep]);

  const handleSave = useCallback(async () => {
    const success = await save();
    if (success) {
      setRestarting(true);

      // Wait for save to be processed
      await new Promise((r) => setTimeout(r, 500));

      // Trigger restart
      await restart();

      // Show restarting message and wait for reload
      setTimeout(() => {
        // Try to reload - server should be back up
        const checkAndReload = async () => {
          try {
            const response = await fetch("/health");
            if (response.ok) {
              onComplete();
              window.location.reload();
            } else {
              setTimeout(checkAndReload, 1000);
            }
          } catch {
            setTimeout(checkAndReload, 1000);
          }
        };

        // Start checking after 3 seconds (give time for restart)
        setTimeout(checkAndReload, 3000);
      }, 100);
    }
  }, [save, restart, onComplete]);

  if (loading) {
    return (
      <div className="setup-wizard">
        <div className="setup-loading">
          <div className="setup-loading-spinner" />
          <span>Yükleniyor...</span>
        </div>
      </div>
    );
  }

  if (restarting) {
    return (
      <div className="setup-wizard">
        <div className="setup-restarting">
          <div className="setup-loading-spinner" />
          <h2>Yeniden Başlatılıyor</h2>
          <p>
            Ayarlarınız kaydedildi. Uygulama yeniden başlatılıyor...
            <br />
            Sayfa birkaç saniye içinde otomatik olarak yenilenecek.
          </p>
        </div>
      </div>
    );
  }

  const renderStepContent = () => {
    switch (step) {
      case 0:
        return (
          <TelegramStep
            formData={formData}
            errors={errors}
            onFieldChange={setField}
          />
        );
      case 1:
        return (
          <ApiKeyStep
            formData={formData}
            errors={errors}
            onFieldChange={setField}
          />
        );
      case 2:
        return (
          <OptionalStep
            formData={formData}
            errors={errors}
            onFieldChange={setField}
          />
        );
      case 3:
        return <ReviewStep formData={formData} saveError={saveError} />;
      default:
        return null;
    }
  };

  return (
    <div className="setup-wizard">
      <div className="setup-wizard-container">
        {/* Header */}
        <div className="setup-header">
          <div className="setup-logo">
            <BrainIcon size={32} />
            <span>Cobrain Kurulum Sihirbazı</span>
          </div>
        </div>

        {/* Step Indicator */}
        <WizardStepIndicator
          currentStep={step}
          totalSteps={4}
          onStepClick={goToStep}
        />

        {/* Step Content */}
        <div className="setup-content">{renderStepContent()}</div>

        {/* Navigation */}
        <div className="setup-footer">
          <div className="setup-footer-left">
            {step > 0 && (
              <Button variant="ghost" onClick={prevStep}>
                ← Geri
              </Button>
            )}
          </div>

          <div className="setup-footer-right">
            {step < 3 ? (
              <Button onClick={nextStep}>
                {step === 0 ? "Başla" : "İleri"} →
              </Button>
            ) : (
              <Button onClick={handleSave} loading={saving}>
                Kaydet ve Başlat
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
