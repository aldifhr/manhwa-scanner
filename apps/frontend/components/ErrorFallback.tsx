"use client";

import React from "react";
import { Info, WarningCircle } from "@phosphor-icons/react";

interface ErrorFallbackProps {
  title: string;
  message?: string;
  onRetry?: () => void;
  icon?: "warning" | "info";
}

export const ErrorFallback = ({
  title,
  message,
  onRetry,
  icon = "warning",
}: ErrorFallbackProps) => {
  const IconComponent = icon === "warning" ? WarningCircle : Info;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-col items-center justify-center py-20 gap-4 text-center"
    >
      <IconComponent size={32} weight="light" className="text-text-muted" />
      <p className="text-text text-lg font-medium">{title}</p>
      {message && <p className="text-text-muted text-sm max-w-md">{message}</p>}
      {onRetry && (
        <button
          autoFocus
          onClick={onRetry}
          className="px-5 py-2 rounded-lg bg-accent text-black text-sm font-medium transition-colors cursor-pointer hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent/50"
        >
          Retry
        </button>
      )}
    </div>
  );
};
