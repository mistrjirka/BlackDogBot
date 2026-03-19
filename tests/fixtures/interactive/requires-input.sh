#!/usr/bin/env bash
# Fixture: prints a marker, waits for stdin input, then prints the received value.
set -euo pipefail

printf "READY_FOR_INPUT\n"
IFS= read -r line
printf "GOT_INPUT:%s\n" "$line"
