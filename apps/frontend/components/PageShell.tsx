import type { ReactNode } from "react";

type Variant = "default" | "narrow" | "bleached";

const variantClass: Record<Variant, string> = {
  default: "max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 md:pb-8",
  narrow: "max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 md:pb-8",
  bleached: "max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8",
};

export function PageShell({
  variant = "default",
  children,
}: {
  variant?: Variant;
  children: ReactNode;
}) {
  return <div className={`${variantClass[variant]} space-y-6`}>{children}</div>;
}

// Convenience: re-export as default for page wrappers that want <PageShell> without import churn
export default PageShell;
