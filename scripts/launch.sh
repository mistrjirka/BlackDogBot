#!/usr/bin/env bash
# launch.sh — Wrapper that detects CUDA 12 libraries before starting BetterClaw.
#
# onnxruntime-node 1.x ships pre-built binaries linked against CUDA 12.
# If the system has CUDA 13+ (e.g. Arch Linux with cuda 13.1), the .so.12
# libs won't be in the linker path and onnxruntime will crash fatally.
#
# This script searches well-known locations for bundled CUDA 12 libraries
# (Ollama, pip nvidia-cublas-cu12, etc.) and prepends them to LD_LIBRARY_PATH
# so the dynamic linker can find them when Node.js loads the native addon.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ---------- CUDA 12 library detection ----------

find_cuda12_dir() {
    # 1. Check if libcublasLt.so.12 is already in the linker cache
    if ldconfig -p 2>/dev/null | grep -q 'libcublasLt.so.12'; then
        return 0   # already available, nothing to do
    fi

    # 2. Search well-known bundled locations
    local candidates=(
        "/usr/local/lib/ollama/cuda_v12"
        "/usr/lib/ollama/cuda_v12"
    )

    for dir in "${candidates[@]}"; do
        if [[ -f "$dir/libcublasLt.so.12" ]]; then
            echo "$dir"
            return 0
        fi
    done

    # 3. Search Python venvs for pip-installed nvidia-cublas-cu12
    local found
    found=$(find /home -maxdepth 8 -path '*/nvidia/cublas/lib/libcublasLt.so.12' -type f 2>/dev/null | head -1)
    if [[ -n "$found" ]]; then
        dirname "$found"
        return 0
    fi

    return 1
}

cuda12_dir=$(find_cuda12_dir 2>/dev/null || true)

if [[ -n "$cuda12_dir" ]]; then
    export LD_LIBRARY_PATH="${cuda12_dir}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    echo "[launch.sh] Prepended CUDA 12 libraries to LD_LIBRARY_PATH: $cuda12_dir"
fi

# ---------- Launch BetterClaw ----------

cd "$PROJECT_DIR"

if [[ "${1:-}" == "--watch" ]]; then
    shift
    exec npx tsx watch src/index.ts "$@"
else
    exec npx tsx src/index.ts "$@"
fi
