#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
swift build -c release
BUILD="$ROOT/.build/release"
echo "Built:"
echo "  $BUILD/BytemapHelper"
echo "  $BUILD/BytemapHelperCtl"
