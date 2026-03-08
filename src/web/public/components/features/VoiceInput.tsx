import React, { useState, useEffect, useCallback, useRef } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { MicIcon, StopIcon, CheckIcon } from "../ui/Icons";

// Web Speech API types
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface VoiceInputProps {
  isOpen: boolean;
  onClose: () => void;
  onTranscript: (text: string) => void;
  language?: string;
}

// Check if Web Speech API is supported
const isSpeechRecognitionSupported =
  typeof window !== "undefined" &&
  ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

export function VoiceInput({
  isOpen,
  onClose,
  onTranscript,
  language = "tr-TR",
}: VoiceInputProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Initialize speech recognition
  useEffect(() => {
    if (!isSpeechRecognitionSupported) {
      setError("Your browser does not support voice input");
      return;
    }

    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) return;

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result && result[0]) {
          if (result.isFinal) {
            final += result[0].transcript + " ";
          } else {
            interim += result[0].transcript;
          }
        }
      }

      if (final) {
        setTranscript((prev) => prev + final);
      }
      setInterimTranscript(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed") {
        setError("Microphone permission denied");
      } else if (event.error === "no-speech") {
        setError("No speech detected");
      } else {
        setError("An error occurred");
      }
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
    };
  }, [language]);

  // Auto-start when modal opens
  useEffect(() => {
    if (isOpen && recognitionRef.current && !isListening) {
      startListening();
    }
  }, [isOpen]);

  // Reset when modal closes
  useEffect(() => {
    if (!isOpen) {
      setTranscript("");
      setInterimTranscript("");
      setError(null);
      if (recognitionRef.current && isListening) {
        recognitionRef.current.stop();
      }
    }
  }, [isOpen, isListening]);

  const startListening = useCallback(() => {
    if (recognitionRef.current) {
      setError(null);
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch (e) {
        console.error("Failed to start recognition:", e);
      }
    }
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
  }, []);

  const handleConfirm = useCallback(() => {
    const finalText = (transcript + interimTranscript).trim();
    if (finalText) {
      onTranscript(finalText);
    }
    onClose();
  }, [transcript, interimTranscript, onTranscript, onClose]);

  const displayText = transcript + interimTranscript;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Voice Input"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!displayText.trim()}>
            <CheckIcon size={16} /> Confirm
          </Button>
        </>
      }
    >
      <div style={{ textAlign: "center" }}>
        {!isSpeechRecognitionSupported ? (
          <div
            style={{
              padding: "var(--space-xl)",
              color: "var(--text-muted)",
            }}
          >
            <MicIcon size={48} />
            <p style={{ marginTop: "var(--space-md)" }}>
              Voice input is not supported in this browser.
            </p>
            <p style={{ marginTop: "var(--space-sm)", fontSize: "var(--text-sm)" }}>
              Please use Chrome or Edge.
            </p>
          </div>
        ) : (
          <>
            {/* Microphone button */}
            <button
              onClick={isListening ? stopListening : startListening}
              style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                border: "none",
                background: isListening ? "var(--error)" : "var(--accent-primary)",
                color: "white",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto",
                transition: "all var(--transition-fast)",
                animation: isListening ? "pulse 1.5s infinite" : "none",
              }}
            >
              {isListening ? <StopIcon size={32} /> : <MicIcon size={32} />}
            </button>

            <p
              style={{
                marginTop: "var(--space-md)",
                color: isListening ? "var(--accent-primary)" : "var(--text-muted)",
                fontWeight: 500,
              }}
            >
              {isListening ? "Listening..." : "Click to speak"}
            </p>

            {/* Transcript display */}
            <div
              style={{
                marginTop: "var(--space-lg)",
                padding: "var(--space-md)",
                background: "var(--bg-tertiary)",
                borderRadius: "var(--radius-md)",
                minHeight: 100,
                textAlign: "left",
              }}
            >
              {displayText ? (
                <p style={{ color: "var(--text-primary)" }}>
                  {transcript}
                  <span style={{ color: "var(--text-muted)" }}>{interimTranscript}</span>
                </p>
              ) : (
                <p style={{ color: "var(--text-muted)", textAlign: "center" }}>
                  Your text will appear here...
                </p>
              )}
            </div>

            {/* Error message */}
            {error && (
              <div
                style={{
                  marginTop: "var(--space-md)",
                  padding: "var(--space-sm)",
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--error)",
                  fontSize: "var(--text-sm)",
                }}
              >
                {error}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
