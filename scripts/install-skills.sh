#!/usr/bin/env bash
# Install the five top-level skills from this repo into an agent skills directory.
# Does NOT vendor external skills. Shared contracts stay in-repo unless --with-shared.
set -euo pipefail

DEST="${HOME}/.agents/skills"
WITH_SHARED=0
COPY=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SKILLS=(
  loop-router
  expanded-grill-with-docs
  codebase-integrity-audit-loop
  human-directed-swarm-planner
  production-flywheel
)

usage() {
  cat <<'EOF'
Usage: install-skills.sh [--dest DIR] [--with-shared] [--copy]

  --dest DIR       Install location (default: ~/.agents/skills)
  --with-shared    Also link/copy shared/ contracts next to skills as
                   <dest>/../markdev-skills-shared or <dest>/_markdev_shared
  --copy           Copy instead of symlink (default on when symlink fails)
  -h, --help       Show this help

Only the five top-level skills are installed. See DEPENDENCIES.md for externals.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST="${2:?--dest requires a path}"
      shift 2
      ;;
    --with-shared)
      WITH_SHARED=1
      shift
      ;;
    --copy)
      COPY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$DEST"

link_or_copy() {
  local src="$1"
  local dst="$2"
  if [[ -e "$dst" || -L "$dst" ]]; then
    echo "skip (exists): $dst"
    return 0
  fi
  if [[ "$COPY" -eq 1 ]]; then
    cp -R "$src" "$dst"
    echo "copied: $dst"
    return 0
  fi
  if ln -s "$src" "$dst" 2>/dev/null; then
    echo "linked: $dst -> $src"
  else
    cp -R "$src" "$dst"
    echo "copied (symlink failed): $dst"
  fi
}

echo "Repo: $REPO_ROOT"
echo "Dest: $DEST"

for name in "${SKILLS[@]}"; do
  src="$REPO_ROOT/skills/$name"
  if [[ ! -f "$src/SKILL.md" ]]; then
    echo "missing skill: $src/SKILL.md" >&2
    exit 1
  fi
  link_or_copy "$src" "$DEST/$name"
done

if [[ "$WITH_SHARED" -eq 1 ]]; then
  shared_dest="$(dirname "$DEST")/markdev-skills-shared"
  mkdir -p "$(dirname "$shared_dest")"
  link_or_copy "$REPO_ROOT/shared" "$shared_dest"
  echo "Note: skills reference shared/ via relative paths from the repo tree."
  echo "      Prefer running from a git checkout, or adjust agent skill roots."
fi

echo "Done. Inventory: $REPO_ROOT/CAPABILITY-MAP.md"
