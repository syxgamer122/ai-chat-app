"use client";

import { useEffect } from "react";

function isEditingElement(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();

  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable ||
    Boolean(
      target.closest("[data-text-editor='true']"),
    )
  );
}

interface UseBranchKeyboardShortcutsOptions {
  enabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function useBranchKeyboardShortcuts({
  enabled = true,
  onPrevious,
  onNext,
}: UseBranchKeyboardShortcutsOptions) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey) {
        return;
      }

      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (isEditingElement(event.target)) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onPrevious();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        onNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, onNext, onPrevious]);
}
