import React, { useState, useId } from "react";
import { cn } from "../../utils/helpers";

interface TextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  hint?: string;
  error?: string;
  type?: "text" | "password" | "number" | "email";
}

export function TextInput({
  label,
  hint,
  error,
  type = "text",
  required,
  className,
  id: providedId,
  ...props
}: TextInputProps) {
  const generatedId = useId();
  const id = providedId || generatedId;
  const [showPassword, setShowPassword] = useState(false);

  const inputType = type === "password" && showPassword ? "text" : type;

  return (
    <div className="text-input-group">
      <label htmlFor={id} className="text-input-label">
        {label}
        {required && <span className="text-input-required">*</span>}
      </label>

      <div className="text-input-wrapper">
        <input
          id={id}
          type={inputType}
          className={cn(
            "text-input",
            error && "text-input--error",
            className
          )}
          aria-invalid={!!error}
          aria-describedby={hint ? `${id}-hint` : undefined}
          {...props}
        />

        {type === "password" && (
          <button
            type="button"
            className="text-input-toggle"
            onClick={() => setShowPassword(!showPassword)}
            tabIndex={-1}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? (
              <EyeOffIcon size={18} />
            ) : (
              <EyeIcon size={18} />
            )}
          </button>
        )}
      </div>

      {hint && !error && (
        <p id={`${id}-hint`} className="text-input-hint">
          {hint}
        </p>
      )}

      {error && (
        <p className="text-input-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// Eye icons
function EyeIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width={size}
      height={size}
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width={size}
      height={size}
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
