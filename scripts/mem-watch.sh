#!/usr/bin/env bash
# mem-watch.sh — Monitor better-claw memory, keep the last 5 samples on disk,
# and preserve the final window if the target process exits while mem-watch is
# still running.
#
# Usage:
#   ./scripts/mem-watch.sh              # auto-find the tsx process
#   ./scripts/mem-watch.sh <PID>        # watch a specific PID
#   ./scripts/mem-watch.sh --snap       # auto-find + immediately take a snapshot
#
# While running:
#   s + Enter  -> take a heap snapshot (SIGUSR2)
#   r + Enter  -> write a diagnostic report (SIGQUIT, if enabled in launch.sh)
#   q + Enter  -> quit mem-watch without marking the run as a crash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIAG_ROOT="${MEMWATCH_DIR:-$PROJECT_DIR/.diagnostics/mem-watch}"
WINDOW_SIZE=5
SAMPLE_INTERVAL_SECONDS=2
CLK_TCK="$(getconf CLK_TCK 2>/dev/null || echo 100)"

RUN_DIR=""
HISTORY_LOG=""
WINDOW_LOG=""
FINAL_WINDOW_LOG=""
META_FILE=""
STATUS_FILE=""

declare -a LAST_SAMPLES=()

find_pid() {
    pgrep -f "tsx.*src/index" | head -1 || true
}

get_proc_start_time() {
    local pid="$1"
    awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true
}

get_proc_comm() {
    local pid="$1"
    cat "/proc/$pid/comm" 2>/dev/null || echo "?"
}

get_proc_status_value_mb() {
    local pid="$1"
    local key="$2"
    awk -v key="$key" '$1 == key":" {print int($2/1024)}' "/proc/$pid/status" 2>/dev/null || echo "?"
}

get_proc_status_value_raw() {
    local pid="$1"
    local key="$2"
    cat "/proc/$pid/$key" 2>/dev/null || echo "?"
}

get_process_uptime_seconds() {
    local pid_start_ticks="$1"
    local system_uptime_seconds

    system_uptime_seconds="$(awk '{print $1}' /proc/uptime 2>/dev/null || echo "")"
    if [[ -z "$system_uptime_seconds" ]]; then
        echo "?"
        return
    fi

    awk -v uptime="$system_uptime_seconds" -v start_ticks="$pid_start_ticks" -v hz="$CLK_TCK" 'BEGIN {
        process_uptime = uptime - (start_ticks / hz);
        if (process_uptime < 0) {
            process_uptime = 0;
        }
        print int(process_uptime);
    }'
}

write_window_log() {
    local tmp_file
    tmp_file="$(mktemp "$RUN_DIR/.last5.XXXXXX")"
    printf "%-10s %10s %10s %10s %10s %10s %10s\n" "TIME" "RSS(MB)" "VSZ(MB)" "SWAP(MB)" "DATA(MB)" "OOM" "UPTIME(s)" > "$tmp_file"
    printf "%-10s %10s %10s %10s %10s %10s %10s\n" "--------" "--------" "--------" "--------" "--------" "--------" "--------" >> "$tmp_file"

    local sample
    for sample in "${LAST_SAMPLES[@]}"; do
        printf "%s\n" "$sample" >> "$tmp_file"
    done

    mv "$tmp_file" "$WINDOW_LOG"
}

append_sample() {
    local sample="$1"
    LAST_SAMPLES+=("$sample")

    while (( ${#LAST_SAMPLES[@]} > WINDOW_SIZE )); do
        LAST_SAMPLES=("${LAST_SAMPLES[@]:1}")
    done

    printf "%s\n" "$sample" >> "$HISTORY_LOG"
    write_window_log
}

freeze_final_window() {
    local reason="$1"
    local now
    now="$(date -Iseconds)"

    if [[ -f "$WINDOW_LOG" ]]; then
        cp -f "$WINDOW_LOG" "$FINAL_WINDOW_LOG"
    fi

    cat > "$STATUS_FILE" <<EOF
state=$reason
pid=$PID
pid_start_time=$PID_START_TIME
finished_at=$now
run_dir=$RUN_DIR
EOF
}

PID="${1:-}"
SNAP_NOW=false

if [[ "$PID" == "--snap" ]]; then
    SNAP_NOW=true
    PID=""
fi

if [[ -z "$PID" ]]; then
    PID="$(find_pid)"
    if [[ -z "$PID" ]]; then
        echo "❌ Could not find better-claw process. Is it running?"
        echo "   Start it with: ./scripts/launch.sh"
        exit 1
    fi
fi

if [[ ! -d "/proc/$PID" ]]; then
    echo "❌ PID $PID does not exist."
    exit 1
fi

PID_START_TIME="$(get_proc_start_time "$PID")"
if [[ -z "$PID_START_TIME" ]]; then
    echo "❌ Could not read start time for PID $PID."
    exit 1
fi

mkdir -p "$DIAG_ROOT"

RUN_ID="$(date +%Y%m%d-%H%M%S)-pid${PID}-start${PID_START_TIME}-$$"
RUN_DIR="$DIAG_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"

HISTORY_LOG="$RUN_DIR/history.log"
WINDOW_LOG="$RUN_DIR/last5.log"
FINAL_WINDOW_LOG="$RUN_DIR/final-last5.log"
META_FILE="$RUN_DIR/meta.env"
STATUS_FILE="$RUN_DIR/status.env"

cat > "$META_FILE" <<EOF
pid=$PID
pid_start_time=$PID_START_TIME
command=$(get_proc_comm "$PID")
started_at=$(date -Iseconds)
project_dir=$PROJECT_DIR
diagnostics_dir=$DIAG_ROOT
window_size=$WINDOW_SIZE
sample_interval_seconds=$SAMPLE_INTERVAL_SECONDS
EOF

cat > "$STATUS_FILE" <<EOF
state=running
pid=$PID
pid_start_time=$PID_START_TIME
updated_at=$(date -Iseconds)
run_dir=$RUN_DIR
EOF

echo "📊 Monitoring PID $PID ($(get_proc_comm "$PID"))"
echo "📁 Run directory: $RUN_DIR"
echo "   Press 's' + Enter to take a heap snapshot"
echo "   Press 'r' + Enter to write a diagnostic report"
echo "   Press 'q' + Enter to quit mem-watch"
echo ""

if $SNAP_NOW; then
    echo "📸 Taking immediate heap snapshot..."
    kill -USR2 "$PID" 2>/dev/null && echo "   Sent SIGUSR2 — snapshot should appear in the Node diagnostics dir" || echo "   ❌ Failed to send signal"
fi

printf "%-10s %10s %10s %10s %10s %10s %10s\n" "TIME" "RSS(MB)" "VSZ(MB)" "SWAP(MB)" "DATA(MB)" "OOM" "UPTIME(s)"
printf "%-10s %10s %10s %10s %10s %10s %10s\n" "--------" "--------" "--------" "--------" "--------" "--------" "--------"

while true; do
    current_start_time="$(get_proc_start_time "$PID")"
    if [[ -z "$current_start_time" ]]; then
        echo "⚠️  Process $PID exited. Preserving final window."
        freeze_final_window "target-exited"
        break
    fi

    if [[ "$current_start_time" != "$PID_START_TIME" ]]; then
        echo "⚠️  PID $PID was reused by another process. Preserving final window."
        freeze_final_window "pid-reused"
        break
    fi

    rss="$(get_proc_status_value_mb "$PID" "VmRSS")"
    vsz="$(get_proc_status_value_mb "$PID" "VmSize")"
    swap="$(get_proc_status_value_mb "$PID" "VmSwap")"
    data="$(get_proc_status_value_mb "$PID" "VmData")"
    oom_score="$(get_proc_status_value_raw "$PID" "oom_score")"
    uptime_seconds="$(get_process_uptime_seconds "$PID_START_TIME")"
    timestamp="$(date +%H:%M:%S)"

    sample_line="$(printf "%-10s %10s %10s %10s %10s %10s %10s" "$timestamp" "$rss" "$vsz" "$swap" "$data" "$oom_score" "$uptime_seconds")"
    append_sample "$sample_line"

    printf "%s\n" "$sample_line"

    cat > "$STATUS_FILE" <<EOF
state=running
pid=$PID
pid_start_time=$PID_START_TIME
updated_at=$(date -Iseconds)
run_dir=$RUN_DIR
last_sample_time=$timestamp
EOF

    if read -t "$SAMPLE_INTERVAL_SECONDS" -r input 2>/dev/null; then
        case "$input" in
            s|S)
                echo "📸 Sending SIGUSR2 to $PID for heap snapshot..."
                kill -USR2 "$PID" 2>/dev/null && echo "   Done — check the Node diagnostics dir" || echo "   ❌ Failed"
                ;;
            r|R)
                echo "🧾 Sending SIGQUIT to $PID for a diagnostic report..."
                kill -QUIT "$PID" 2>/dev/null && echo "   Done — check the Node diagnostics dir" || echo "   ❌ Failed"
                ;;
            q|Q)
                cat > "$STATUS_FILE" <<EOF
state=watcher-stopped
pid=$PID
pid_start_time=$PID_START_TIME
finished_at=$(date -Iseconds)
run_dir=$RUN_DIR
EOF
                echo "👋 Bye"
                exit 0
                ;;
        esac
    fi
done
