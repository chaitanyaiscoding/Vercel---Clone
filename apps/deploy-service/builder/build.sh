#!/bin/sh
# Runs INSIDE the untrusted builder container.
# Downloads the repo at an exact commit, installs deps with the repo's own package
# manager, runs its build, and copies the static output to /home/node/output,
# which the deploy-service copies out with `docker cp` after the container exits.
# Exit codes: 10 = no package.json, 11 = no static output found, other = install/build failed.
set -eu

: "${TARBALL_URL:?TARBALL_URL is required}"

echo "→ downloading source"
# --max-filesize: refuse tarballs over 200 MB
curl -fsSL --max-filesize 209715200 "$TARBALL_URL" | tar -xz --strip-components=1

[ -f package.json ] || { echo "✗ no package.json at repo root"; exit 10; }

echo "→ installing dependencies"
if   [ -f pnpm-lock.yaml ];    then corepack pnpm install --frozen-lockfile
elif [ -f yarn.lock ];         then corepack yarn install
elif [ -f package-lock.json ]; then npm ci
else                                npm install
fi

echo "→ building"
npm run build

for d in dist build out; do
  if [ -f "$d/index.html" ]; then
    cp -r "$d"/. /home/node/output/
    echo "✓ output from ./$d"
    exit 0
  fi
done

echo "✗ no dist/, build/ or out/ containing index.html"
exit 11
