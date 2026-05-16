import * as React from "react"

function Card({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={[
        "flex flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-sm text-card-foreground ring-1 ring-foreground/10",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={[
        "grid auto-rows-min items-start gap-1 rounded-t-xl px-4",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={[
        "font-heading text-base leading-snug font-medium",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={["px-4", className].filter(Boolean).join(" ")}
      {...props}
    />
  )
}

export { Card, CardHeader, CardTitle, CardContent }
