import React, { useState } from "react";
import { CopyIcon, CheckIcon } from "../ui/Icons";
import { copyToClipboard } from "../../utils/helpers";

interface CodeBlockProps {
  language?: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(code);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language || "code"}</span>
        <button
          className={`code-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          aria-label={copied ? "Kopyalandı" : "Kopyala"}
        >
          {copied ? (
            <>
              <CheckIcon size={12} /> Kopyalandı
            </>
          ) : (
            <>
              <CopyIcon size={12} /> Kopyala
            </>
          )}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
