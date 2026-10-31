#!/bin/sh
set -eu
umask 077
case "${NAPSHOT_SITE_ONLY:-false}" in
  true) exec deno run --no-prompt --frozen --cached-only -A src/main.ts --site-only ;;
  false) exec deno run --no-prompt --frozen --cached-only -A src/main.ts ;;
  *) echo 'NAPSHOT_SITE_ONLY must be true or false' >&2; exit 1 ;;
esac
