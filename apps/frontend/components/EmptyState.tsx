import { IconContext } from "@phosphor-icons/react";

interface EmptyStateProps {
  icon?: React.ReactNode;
  message: string;
  subMessage?: string;
  action?: React.ReactNode;
}

export default function EmptyState({
  icon,
  message,
  subMessage,
  action,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center py-12 gap-3 text-center"
    >
      {icon && (
        <IconContext.Provider
          value={{
            size: 32,
            weight: "light",
            className: "text-text-muted",
          }}
        >
          {icon}
        </IconContext.Provider>
      )}
      <p className="text-sm font-medium text-text">{message}</p>
      {subMessage && <p className="text-xs text-text-muted">{subMessage}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
