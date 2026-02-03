import React from "react";
import { BrainIcon } from "../ui/Icons";

export function EmptyState() {
  return (
    <div className="empty-state">
      <BrainIcon size={64} />
      <h2>Cobrain</h2>
      <p>Merhaba! Sana nasıl yardımcı olabilirim?</p>
    </div>
  );
}
