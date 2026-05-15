import * as React from "react"

import { cn } from "@/lib/utils"

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/85",
  outline:
    "border-border bg-background hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
}

const sizes = {
  default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-start]:pl-2",
  sm: "h-7 gap-1 px-2.5 text-[0.8rem] has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
}) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none transition-[background-color,border-color,color,box-shadow,translate] hover:-translate-y-0.5 hover:shadow-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  )
}

export { Button }
