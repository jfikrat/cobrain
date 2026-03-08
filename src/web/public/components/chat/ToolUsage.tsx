import React from "react";
import { ToolIcon } from "../ui/Icons";
import type { ToolUse } from "../../types";

interface ToolUsageProps {
  tool: ToolUse;
}

export function ToolUsage({ tool }: ToolUsageProps) {
  return (
    <div className="tool-usage">
      <div className="tool-header">
        <ToolIcon className="tool-icon" />
        <span className="tool-name">{tool.name}</span>
        <span className={`tool-status ${tool.status}`}>
          {tool.status === "running" ? "Running..." : tool.status === "success" ? "Success" : "Error"}
        </span>
      </div>
    </div>
  );
}
