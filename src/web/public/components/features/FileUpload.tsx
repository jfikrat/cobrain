import React, { useRef, useState, useCallback } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { PaperclipIcon, XIcon, CheckIcon } from "../ui/Icons";
import { cn } from "../../utils/helpers";

interface FileUploadProps {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (files: File[]) => void;
  accept?: string;
  maxSize?: number; // in MB
  maxFiles?: number;
}

export function FileUpload({
  isOpen,
  onClose,
  onUpload,
  accept = "image/*,.pdf,.txt,.md,.json,.csv",
  maxSize = 10, // 10MB default
  maxFiles = 5,
}: FileUploadProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateFile = useCallback(
    (file: File): string | null => {
      if (file.size > maxSize * 1024 * 1024) {
        return `Dosya ${maxSize}MB'dan büyük olamaz`;
      }
      return null;
    },
    [maxSize]
  );

  const handleFiles = useCallback(
    (newFiles: FileList | File[]) => {
      setError(null);
      const fileArray = Array.from(newFiles);

      // Check max files
      if (files.length + fileArray.length > maxFiles) {
        setError(`En fazla ${maxFiles} dosya yüklenebilir`);
        return;
      }

      // Validate each file
      const validFiles: File[] = [];
      for (const file of fileArray) {
        const validationError = validateFile(file);
        if (validationError) {
          setError(validationError);
          return;
        }
        validFiles.push(file);
      }

      setFiles((prev) => [...prev, ...validFiles]);
    },
    [files.length, maxFiles, validateFile]
  );

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files);
      }
    },
    [handleFiles]
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleUpload = useCallback(() => {
    if (files.length > 0) {
      onUpload(files);
      setFiles([]);
      onClose();
    }
  }, [files, onUpload, onClose]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Dosya Yükle"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            İptal
          </Button>
          <Button onClick={handleUpload} disabled={files.length === 0}>
            <CheckIcon size={16} /> Yükle ({files.length})
          </Button>
        </>
      }
    >
      <div>
        {/* Drop zone */}
        <div
          className={cn("drop-zone", dragActive && "active")}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${dragActive ? "var(--accent-primary)" : "var(--border-color)"}`,
            borderRadius: "var(--radius-lg)",
            padding: "var(--space-xl)",
            textAlign: "center",
            cursor: "pointer",
            background: dragActive ? "var(--accent-muted)" : "var(--bg-tertiary)",
            transition: "all var(--transition-fast)",
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            multiple={maxFiles > 1}
            onChange={handleInputChange}
            style={{ display: "none" }}
          />
          <PaperclipIcon size={32} />
          <p style={{ marginTop: "var(--space-md)", color: "var(--text-primary)" }}>
            Dosyaları buraya sürükleyin
          </p>
          <p style={{ marginTop: "var(--space-xs)", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            veya tıklayarak seçin
          </p>
          <p style={{ marginTop: "var(--space-sm)", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
            Max {maxSize}MB, {maxFiles} dosya
          </p>
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

        {/* File list */}
        {files.length > 0 && (
          <div style={{ marginTop: "var(--space-md)" }}>
            {files.map((file, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-sm)",
                  padding: "var(--space-sm)",
                  background: "var(--bg-tertiary)",
                  borderRadius: "var(--radius-md)",
                  marginBottom: "var(--space-xs)",
                }}
              >
                <PaperclipIcon size={16} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {file.name}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
                  {formatFileSize(file.size)}
                </span>
                <button
                  onClick={() => removeFile(index)}
                  style={{
                    padding: "var(--space-xs)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-muted)",
                  }}
                >
                  <XIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
