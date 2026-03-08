import React from "react";
import { cn } from "../../utils/helpers";

interface WizardStepProps {
  currentStep: number;
  totalSteps: number;
  onStepClick: (step: number) => void;
}

const STEP_LABELS = ["Telegram", "Gemini API", "Advanced", "Summary"];

export function WizardStepIndicator({
  currentStep,
  totalSteps,
  onStepClick,
}: WizardStepProps) {
  return (
    <div className="wizard-steps">
      {Array.from({ length: totalSteps }, (_, i) => (
        <React.Fragment key={i}>
          <button
            type="button"
            className={cn(
              "wizard-step",
              i === currentStep && "wizard-step--active",
              i < currentStep && "wizard-step--completed"
            )}
            onClick={() => onStepClick(i)}
            disabled={i > currentStep}
            aria-current={i === currentStep ? "step" : undefined}
          >
            <span className="wizard-step-number">
              {i < currentStep ? (
                <CheckIcon size={14} />
              ) : (
                i + 1
              )}
            </span>
            <span className="wizard-step-label">{STEP_LABELS[i]}</span>
          </button>

          {i < totalSteps - 1 && (
            <div
              className={cn(
                "wizard-step-connector",
                i < currentStep && "wizard-step-connector--completed"
              )}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function CheckIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      width={size}
      height={size}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
