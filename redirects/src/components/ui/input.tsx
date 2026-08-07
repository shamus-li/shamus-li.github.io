import type { ComponentProps } from "react"

function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={[
        "h-8 w-full min-w-0 rounded-lg border border-input bg-input/30 px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/80 disabled:opacity-50 aria-invalid:border-destructive/50 aria-invalid:ring-3 aria-invalid:ring-destructive/40 md:text-sm",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  )
}

export { Input }
