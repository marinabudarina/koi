#!/usr/bin/env bash
# Build the web app for GitHub Pages (served from /koi-hero/) and force-push dist to the gh-pages branch.
set -euo pipefail
cd "$(dirname "$0")/packages/web"
rm -rf dist
VITE_BASE=/koi-hero/ bunx vite build
cd dist
touch .nojekyll
git init -q -b gh-pages
git add -A
git -c user.name="deploy" -c user.email="deploy@users.noreply.github.com" commit -q -m "Deploy to GitHub Pages"
git push -q -f "${REPO_URL:-https://github.com/marinabudarina/koi-hero.git}" gh-pages
