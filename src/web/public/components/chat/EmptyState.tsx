import React from "react";
import { BrainIcon } from "../ui/Icons";

export function EmptyState() {
  return (
    <div className="empty-state">
      <BrainIcon size={64} />
      <h2>Cobrain</h2>
      <p>Hello! How can I help you?</p>
    </div>
  );
}
