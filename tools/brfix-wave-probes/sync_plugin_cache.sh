#!/usr/bin/env bash
# sync_plugin_cache.sh — sync the bkit repo plugin files into the marketplace
# plugin cache so the LIVE session's hooks stop running stale code (br009
# second clause: live hooks load from the plugin cache, not the repo).
#
# DRY-RUN DEFAULT. Pass --apply to mutate. Backup is mandatory before apply;
# --apply is refused if the backup fails.
#
# Usage:
#   tools/brfix-wave-probes/sync_plugin_cache.sh            # plan only
#   tools/brfix-wave-probes/sync_plugin_cache.sh --apply    # backup + sync
#   BKIT_CACHE_VERSION=2.1.40 tools/.../sync_plugin_cache.sh [--apply]
#
# @module tools/brfix-wave-probes/sync_plugin_cache
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CACHE_BASE="${BKIT_CACHE_BASE:-$HOME/.claude/plugins/cache/bkit-marketplace/bkit}"
BACKUP_ROOT="${REPO_ROOT}/work/backups"

APPLY=0
for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY=1 ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      echo "Usage: $0 [--apply]" >&2
      exit 2
      ;;
  esac
done

# --- resolve target cache version dir (newest numeric version unless pinned) ---
if [[ -n "${BKIT_CACHE_VERSION:-}" ]]; then
  CACHE_VER="${BKIT_CACHE_VERSION}"
else
  CACHE_VER="$(ls -1 "${CACHE_BASE}" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1 || true)"
fi
if [[ -z "${CACHE_VER}" || ! -d "${CACHE_BASE}/${CACHE_VER}" ]]; then
  echo "ERROR: no plugin cache version dir found under ${CACHE_BASE}" >&2
  echo "       (tried BKIT_CACHE_VERSION='${BKIT_CACHE_VERSION:-<auto>}')" >&2
  exit 1
fi
CACHE_ROOT="${CACHE_BASE}/${CACHE_VER}"

# --- what gets synced (dirs + optional top-level files) ---
SYNC_DIRS=(scripts lib hooks skills templates commands agents .claude-plugin)
SYNC_FILES=(plugin.json)

echo "=== brfix-wave plugin-cache sync plan ==="
echo "  repo source : ${REPO_ROOT}"
echo "  cache target: ${CACHE_ROOT}"
echo "  mode        : $([[ ${APPLY} -eq 1 ]] && echo 'APPLY (mutating)' || echo 'DRY-RUN (no changes)')"
echo "  dirs        : ${SYNC_DIRS[*]}"
file_list="dirs: ${SYNC_DIRS[*]}"
for f in "${SYNC_FILES[@]}"; do
  if [[ -f "${REPO_ROOT}/${f}" ]]; then
    echo "  file        : ${f} (present in repo)"
    file_list="${file_list}; file: ${f}"
  else
    echo "  file        : ${f} (absent in repo — skipped)"
  fi
done
echo

# --- sanity: target must exist and look like the bkit plugin ---
if [[ ! -d "${CACHE_ROOT}/scripts" || ! -d "${CACHE_ROOT}/lib" ]]; then
  echo "ERROR: ${CACHE_ROOT} does not look like the bkit plugin cache (missing scripts/ or lib/)." >&2
  exit 1
fi

# --- show what would change ---
echo "--- change preview (repo -> cache) ---"
preview_any=0
for d in "${SYNC_DIRS[@]}"; do
  if [[ ! -d "${REPO_ROOT}/${d}" ]]; then
    echo "  SKIP ${d}/ (not in repo)"
    continue
  fi
  if diff -rq "${REPO_ROOT}/${d}" "${CACHE_ROOT}/${d}" >/tmp/brfix-sync-diff.$$ 2>&1; then
    echo "  IN-SYNC ${d}/"
  else
    preview_any=1
    echo "  DIFFERS ${d}/:"
    sed 's/^/    /' /tmp/brfix-sync-diff.$$ | head -20
    local_lines="$(wc -l < /tmp/brfix-sync-diff.$$)"
    if (( local_lines > 20 )); then
      echo "    … and $((local_lines - 20)) more"
    fi
  fi
done
rm -f /tmp/brfix-sync-diff.$$
if (( preview_any == 0 )); then
  echo
  echo "Everything already in sync — nothing to do."
  exit 0
fi

if (( APPLY == 0 )); then
  echo
  echo "DRY-RUN complete. No changes made."
  echo "To apply: ${SCRIPT_DIR}/sync_plugin_cache.sh --apply"
  exit 0
fi

# --- APPLY: mandatory backup first; refuse on backup failure ---
STAMP="$(date +%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/cache-sync-${STAMP}"
mkdir -p "${BACKUP_DIR}"
echo
echo "--- backup -> ${BACKUP_DIR} ---"
TARBALL="${BACKUP_DIR}/cache-${CACHE_VER}.tar.gz"
if ! tar -czf "${TARBALL}" -C "${CACHE_BASE}" "${CACHE_VER}"; then
  echo "ERROR: backup failed — refusing to mutate the cache." >&2
  echo "       (partial backup at ${TARBALL} left in place for inspection)" >&2
  exit 1
fi
echo "  wrote ${TARBALL} ($(du -h "${TARBALL}" | cut -f1))"

# --- sync ---
echo
echo "--- syncing ---"
for d in "${SYNC_DIRS[@]}"; do
  if [[ ! -d "${REPO_ROOT}/${d}" ]]; then
    continue
  fi
  echo "  rsync -a --delete ${d}/ -> cache"
  rsync -a --delete "${REPO_ROOT}/${d}/" "${CACHE_ROOT}/${d}/"
done
for f in "${SYNC_FILES[@]}"; do
  if [[ -f "${REPO_ROOT}/${f}" ]]; then
    echo "  cp ${f} -> cache"
    cp "${REPO_ROOT}/${f}" "${CACHE_ROOT}/${f}"
  fi
done

echo
echo "APPLY complete: ${REPO_ROOT} -> ${CACHE_ROOT}"
echo "Backup: ${TARBALL}"
echo "NOTE: already-running sessions may hold the old hook in memory until restart."
