# Redirect manager

The protected React dashboard at `/redirects/` and its exact Pages Function at
`/redirects/api` share the redirect domain model in `redirect.ts`.
Cloudflare slash variants are expanded and collapsed only by the server adapter.

Run development, tests, type checking, linting, and builds from the repository
root. The Function adds and deletes only its own entries in the Bulk Redirect
List `REDIRECT_LIST_ID`, so entries outside `REDIRECT_HOSTNAME` in that shared
list are left untouched.
