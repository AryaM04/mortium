// An accessible labeled input, with the error text linked through
// aria-describedby and aria-invalid set on the input.
import { useId, type InputHTMLAttributes } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export function FormField({ label, error, id, ...inputProps }: FormFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[13px] font-medium text-secondary">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errorId : undefined}
        className="field"
        {...inputProps}
      />
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
