#!/usr/bin/env bash
# Install every skill under skills/ that has a root SKILL.md into an agent skills directory.
# Shared contracts are installed only with --with-shared. True externals stay in DEPENDENCIES.md.
set -euo pipefail

DEST="${HOME}/.agents/skills"
WITH_SHARED=0
COPY=0
LINKED=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: install-skills.sh [--dest DIR] [--with-shared] [--copy]

  --dest DIR       Install location (default: ~/.agents/skills)
  --with-shared    Also link/copy shared/ to <dest>/shared, where bundled
                   scripts resolve it (require("../shared/...")). Symlinked
                   skills resolve from their real path, so this also links
                   skills/shared -> ../shared inside the repo (gitignored).
  --copy           Copy instead of symlink (default on when symlink fails)
  -h, --help       Show this help

Installs every skills/<name>/SKILL.md package discovered in this repo.
See DEPENDENCIES.md for true externals not owned here.
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
  if ln -s "$src" "$dst" 2>/dev/null && [[ -L "$dst" ]]; then
    LINKED=1
    echo "linked: $dst -> $src"
  elif [[ -e "$dst" ]]; then
    # Git Bash's ln -s copies instead of linking unless native symlinks are enabled.
    echo "copied (ln -s made a copy): $dst"
  else
    cp -R "$src" "$dst"
    echo "copied (symlink failed): $dst"
  fi
}

echo "Repo: $REPO_ROOT"
echo "Dest: $DEST"

SKILLS_DIR="$REPO_ROOT/skills"
shopt -s nullglob
found=0
for src in "$SKILLS_DIR"/*/; do
  name="$(basename "$src")"
  [[ "$name" == "shared" ]] && continue
  if [[ ! -f "$src/SKILL.md" ]]; then
    echo "skip (no SKILL.md): $src" >&2
    continue
  fi
  found=1
  link_or_copy "${src%/}" "$DEST/$name"
done
shopt -u nullglob

if [[ "$found" -eq 0 ]]; then
  echo "no skills found under $SKILLS_DIR/*/SKILL.md" >&2
  exit 1
fi

if [[ "$WITH_SHARED" -eq 1 ]]; then
  skills_linked="$LINKED"
  link_or_copy "$REPO_ROOT/shared" "$DEST/shared"
  if [[ "$skills_linked" -eq 1 ]]; then
    repo_link="$SKILLS_DIR/shared"
    if [[ -e "$repo_link" || -L "$repo_link" ]]; then
      echo "skip (exists): $repo_link"
    elif ln -s ../shared "$repo_link" 2>/dev/null && [[ -L "$repo_link" ]]; then
      echo "linked: $repo_link -> ../shared (lets symlinked skills resolve shared/)"
    else
      rm -rf "$repo_link"
      echo "warning: could not link $repo_link -> ../shared; symlinked skills' scripts" >&2
      echo "         will not find shared/. Re-run with --copy." >&2
    fi
  fi
fi

echo "Done. Inventory: $REPO_ROOT/CAPABILITY-MAP.md"
