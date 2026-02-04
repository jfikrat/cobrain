import React, { useState, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles/output.css";

import { ChatLayout } from "./components/chat/ChatLayout";
import { SearchModal } from "./components/features/SearchModal";
import { ExportDialog } from "./components/features/ExportDialog";
import { SetupWizard } from "./components/setup/SetupWizard";
import { useConversations } from "./hooks/useConversations";
import { useKeyboardShortcut, SHORTCUTS } from "./hooks/useKeyboardShortcuts";

function App() {
  // Setup mode state
  const [setupMode, setSetupMode] = useState<boolean | null>(null);

  // Check setup status on mount
  useEffect(() => {
    async function checkSetupStatus() {
      try {
        const response = await fetch("/api/setup/status");
        const data = await response.json();
        setSetupMode(data.setupRequired);
      } catch {
        // If status endpoint doesn't exist, assume normal mode
        setSetupMode(false);
      }
    }

    checkSetupStatus();
  }, []);

  // Get token from URL (only needed in normal mode)
  const token = new URLSearchParams(window.location.search).get("token");

  // Modal states
  const [searchOpen, setSearchOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Conversations for modals
  const { conversations, activeConversation, switchConversation } = useConversations();

  // Keyboard shortcuts for modals
  useKeyboardShortcut(SHORTCUTS.CLOSE_MODAL, () => {
    if (searchOpen) setSearchOpen(false);
    if (exportOpen) setExportOpen(false);
  });

  // Handle search result selection
  const handleSearchSelect = useCallback(
    (conversationId: string, _messageId: string) => {
      switchConversation(conversationId);
      setSearchOpen(false);
      // TODO: Scroll to specific message
    },
    [switchConversation]
  );

  // Handle setup completion
  const handleSetupComplete = useCallback(() => {
    setSetupMode(false);
  }, []);

  // Loading state - checking setup status
  if (setupMode === null) {
    return (
      <div
        className="app"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
        }}
      >
        <div className="setup-loading">
          <div className="setup-loading-spinner" />
          <span>Yükleniyor...</span>
        </div>
      </div>
    );
  }

  // Setup mode - show wizard
  if (setupMode) {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  // Normal mode - no token
  if (!token) {
    return (
      <div
        className="app"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
        }}
      >
        <div className="error-banner" style={{ maxWidth: "400px", textAlign: "center" }}>
          <h2 style={{ marginBottom: "var(--space-md)" }}>Token Bulunamadı</h2>
          <p>Lütfen Telegram'dan /web komutu ile yeni link alın.</p>
        </div>
      </div>
    );
  }

  // Normal mode - with token
  return (
    <>
      <ChatLayout
        token={token}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenExport={() => setExportOpen(true)}
      />

      <SearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        conversations={conversations}
        onSelectResult={handleSearchSelect}
      />

      <ExportDialog
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        conversations={conversations}
        activeConversation={activeConversation}
      />
    </>
  );
}

// Mount
const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
