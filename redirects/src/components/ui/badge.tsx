import * as React from "react"

import { cn } from "@/lib/utils"

function Badge({
  className,
  ...props
}: React.ComponentProps<"span"> & { variant?: "secondary" }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-4xl bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Badge }
