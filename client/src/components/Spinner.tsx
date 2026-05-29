interface SpinnerProps {
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLASS = {
  xs:  "h-3 w-3 border-[1.5px]",
  sm:  "h-4 w-4 border-2",
  md:  "h-8 w-8 border-[3px]",
  lg:  "h-12 w-12 border-4",
} as const;

export function Spinner({ size = "md", className = "" }: SpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-gray-200 border-t-[#FF3621] shrink-0 ${SIZE_CLASS[size]}${className ? ` ${className}` : ""}`}
    />
  );
}
