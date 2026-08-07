# Redirect manager

The protected React dashboard at `/redirects/` and its exact Pages Function at
`/redirects/api` share the redirect domain model in `redirect.ts`.
Cloudflare slash variants are expanded and collapsed only by the server adapter.

Run development, tests, type checking, linting, and builds from the repository
root. The Function currently preserves entries outside `REDIRECT_HOSTNAME` in
the configured shared `REDIRECT_LIST_NAME`; moving these redirects to a
dedicated list remains an infrastructure migration.
