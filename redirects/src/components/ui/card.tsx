import type { ComponentProps } from "react"

function Card({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
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

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
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

function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={[
        "text-base leading-snug font-medium",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={["px-4", className].filter(Boolean).join(" ")}
      {...props}
    />
  )
}

export { Card, CardHeader, CardTitle, CardContent }
