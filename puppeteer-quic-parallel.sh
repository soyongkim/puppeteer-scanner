#!/bin/bash

# =============================================================================
# QUIC Proxy - Client Scanner
# =============================================================================
# This script performs automated testing of domains through QUIC proxy with connection 
# migration capabilities. For each test, it spawns fresh proxy and client instances to 
# ensure stable and isolated results.
#
# How it works:
# 1. Reads domain list from input file
# 2. For each domain test:
#    - Starts a fresh QUIC proxy server instance (launch_proxy.sh + quiche_server)
#    - Runs client test (puppeteer_chromium_client.js) against the domain through proxy
#    - Collects comprehensive performance and migration statistics
#    - Kills both proxy and client processes completely
#    - Repeats for next domain with clean proxy/client session
# 3. Supports parallel execution with isolated proxy instances per worker
# 4. Aggregates results into CSV format
#
# Usage:
#   ./puppeteer-quic-parallel.sh [options]
#
# Options:
#   --input=FILE         Input domain list (default: tranco_full_list.txt)
#   --output_dir=DIR     Output directory (default: scan_results)
#   --start=N            Start from domain N (for resumption)
#   --max=N              Maximum domains to process
#   --parallel=N         Number of parallel scans (default: 1)
#   --timeout=N          Timeout per domain in seconds (default: 60)
#   --interface=NAME     Network interface for proxy (e.g., eth0, nordlynx, tun0)
#   --migrate=NAME       Migration interface for proxy (e.g., nordlynx, tun0)
#   --num=N              Number of runs per domain (default: 1)
#   --no-proxy           Run without proxy (direct connection)
#   --pv-migration       Enable path validation migration in proxy
#   --pair               Enable paired mode: baseline + migration phases
#
# Output CSV Format:
#   Compatible with compare_enhanced.js format including proxy statistics:
#   SNI, ip_addr, ip_country, main_status, languages, domains_analysis,
#   TCP_return, total_connections, total_data_amount, total_migrated_data_amount, 
#   migration_success_rate, load_time, and 30+ additional performance metrics
# =============================================================================

set -euo pipefail


# ── Configuration ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_SCRIPT="$HOME/Workspace/puppeteer-scanner/puppeteer-client.js"
CLIENT_SCRIPT_DIR="$(dirname "$CLIENT_SCRIPT")"
PROXY_SCRIPT="$HOME/Workspace/quic_proxy/launch_proxy.sh"

# Default settings
INPUT_FILE="$SCRIPT_DIR/tranco_full_list.txt"
OUTPUT_DIR="$SCRIPT_DIR/scan_results"
START_FROM=1
MAX_DOMAINS=0
PARALLEL_JOBS=1
TIMEOUT=60
INTERFACE=""
MIGRATE=""
NUM_RUNS=1
NO_PROXY=false
PV_MIGRATION=false
PAIR_MODE=false


# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --input=*)
            INPUT_FILE="${1#*=}"
            shift
            ;;
        --output_dir=*)
            OUTPUT_DIR="${1#*=}"
            shift
            ;;
        --start=*)
            START_FROM="${1#*=}"
            shift
            ;;
        --max=*)
            MAX_DOMAINS="${1#*=}"
            shift
            ;;
        --parallel=*)
            PARALLEL_JOBS="${1#*=}"
            shift
            ;;
        --timeout=*)
            TIMEOUT="${1#*=}"
            shift
            ;;
        --interface=*)
            INTERFACE="${1#*=}"
            shift
            ;;
        --migrate=*)
            MIGRATE="${1#*=}"
            shift
            ;;
        --num=*)
            NUM_RUNS="${1#*=}"
            shift
            ;;
        --no-proxy)
            NO_PROXY=true
            shift
            ;;
        --pv-migration)
            PV_MIGRATION=true
            shift
            ;;
        --pair)
            PAIR_MODE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [options]"
            echo ""
            echo "QUIC Proxy Parallel Scanner - Test domains through QUIC proxy with migration"
            echo ""
            echo "Options:"
            echo "  --input=FILE         Input domain list (default: tranco_full_list.txt)"
            echo "  --output_dir=DIR     Output directory (default: scan_results)"
            echo "  --start=N            Start from domain N (for resumption)"
            echo "  --max=N              Maximum domains to process"
            echo "  --parallel=N         Number of parallel workers (default: 1)"
            echo "  --timeout=N          Timeout per domain in seconds (default: 60)"
            echo "  --interface=NAME     Network interface for proxy (e.g., ens3, tun0)"
            echo "  --migrate=NAME       Migration interface for proxy (e.g., tun0)"
            echo "  --num=N              Number of runs per domain (default: 1)"
            echo "  --no-proxy           Run without proxy (direct connection)"
            echo "  --pv-migration       Enable path validation migration in proxy"
            echo "  --pair               Enable paired mode: baseline + migration phases"
            echo ""
            echo "Modes:"
            echo "  1. Regular mode:  Test each domain N times (--num=N)"
            echo "  2. Paired mode:   Run baseline + migration phases separately (--pair --migrate=IF)"
            echo "  3. Direct mode:   Test without proxy (--no-proxy)"
            echo "  4. Parallel mode: Run multiple workers simultaneously (--parallel=N)"
            echo ""
            echo "Examples:"
            echo "  # Basic single interface scan"
            echo "  $0 --interface=ens3 --input=domains.txt"
            echo ""
            echo "  # Scan with migration (regular mode)"
            echo "  $0 --interface=ens3 --migrate=tun0 --num=3"
            echo ""
            echo "  # Paired mode: baseline + migration phases"
            echo "  $0 --interface=ens3 --migrate=tun0 --pair --num=5"
            echo ""
            echo "  # Parallel execution with 4 workers"
            echo "  $0 --interface=ens3 --migrate=tun0 --parallel=4"
            echo ""
            echo "  # Resume from domain 100, process 50 domains"
            echo "  $0 --interface=ens3 --start=100 --max=50"
            echo ""
            echo "  # Direct connection (no proxy)"
            echo "  $0 --no-proxy --input=domains.txt"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# ── Validation ───────────────────────────────────────────────────────────────
if [[ ! -f "$INPUT_FILE" ]]; then
    echo "Error: Input file '$INPUT_FILE' not found"
    exit 1
fi

if [[ ! -f "$CLIENT_SCRIPT" ]]; then
    echo "Error: Client script '$CLIENT_SCRIPT' not found"
    exit 1
fi

if [[ ! -f "$PROXY_SCRIPT" ]] && [[ "$NO_PROXY" != "true" ]]; then
    echo "Error: Proxy script '$PROXY_SCRIPT' not found"
    exit 1
fi

# Verify that the client script has fetchProxyStats function (enhanced version)
if ! grep -q "fetchProxyStats" "$CLIENT_SCRIPT" && [[ "$NO_PROXY" != "true" ]]; then
    echo "Warning: Client script may not have proxy statistics support"
    echo "   Make sure you're using the enhanced version with fetchProxyStats()"
fi

# Validate NUM_RUNS parameter
if ! [[ "$NUM_RUNS" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: --num must be a positive integer (got: $NUM_RUNS)"
    exit 1
fi

if [[ $NUM_RUNS -gt 10 ]]; then
    echo "Warning: Running $NUM_RUNS tests per domain - this will take significantly longer"
    read -p "Continue? (y/N): " -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled by user"
        exit 0
    fi
fi

# ── Setup ────────────────────────────────────────────────────────────────────
# Generate timestamp for unique result directory
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
TIMESTAMPED_OUTPUT_DIR="$OUTPUT_DIR/bypassing_results_$TIMESTAMP"
mkdir -p "$TIMESTAMPED_OUTPUT_DIR"

# Time tracking
SCRIPT_START_TIME=$(date +%s)
START_TIME_DISPLAY=$(date '+%Y-%m-%d %H:%M:%S')

LOG_FILE="$TIMESTAMPED_OUTPUT_DIR/scan.log"
CSV_FILE="$TIMESTAMPED_OUTPUT_DIR/bypassing_results"  # Base name, will append interface
SUMMARY_FILE="$TIMESTAMPED_OUTPUT_DIR/summary.txt"

# CSV files will be automatically created by compare_enhanced.js with proper headers

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

error_log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] ERROR: $1" | tee -a "$LOG_FILE"
}

# Format seconds into human readable time
format_duration() {
    local seconds=$1
    local hours=$((seconds / 3600))
    local minutes=$(((seconds % 3600) / 60))
    local secs=$((seconds % 60))
    
    if [[ $hours -gt 0 ]]; then
        printf "%dh %dm %ds" $hours $minutes $secs
    elif [[ $minutes -gt 0 ]]; then
        printf "%dm %ds" $minutes $secs
    else
        printf "%ds" $secs
    fi
}

# ── Parallel Execution Functions ──────────────────────────────────────────────

# Generate random port for parallel proxy instances
generate_random_port() {
    local base_port=4433
    local random_offset=$((RANDOM % 1000))
    echo $((base_port + random_offset))
}

# Divide domain list into chunks for parallel processing
divide_domains() {
    local domains_file="$1"
    local num_chunks="$2"
    local output_dir="$3"
    
    local total_domains=$(wc -l < "$domains_file")
    local chunk_size=$(( (total_domains + num_chunks - 1) / num_chunks ))  # Round up
    
    log "Dividing $total_domains domains into $num_chunks chunks (~$chunk_size domains each)"
    
    # Global variable to store chunk files
    CHUNK_FILES=()
    
    # Create chunk files
    for ((i=1; i<=num_chunks; i++)); do
        local chunk_file="$output_dir/chunk_${i}.txt"
        local start_line=$(( (i-1) * chunk_size + 1 ))
        local end_line=$((i * chunk_size))
        
        sed -n "${start_line},${end_line}p" "$domains_file" > "$chunk_file"
        local actual_lines=$(wc -l < "$chunk_file")
        
        if [[ $actual_lines -gt 0 ]]; then
            CHUNK_FILES+=("$chunk_file")
            log "Chunk $i: lines $start_line-$end_line ($actual_lines domains) -> $chunk_file"
        else
            rm -f "$chunk_file"  # Remove empty chunk
        fi
    done
}

# Worker-specific proxy management (uses custom ports for parallel execution)
start_proxy_worker() {
    local interface="$1"
    local migrate_interface="$2" 
    local port="$3"
    local worker_id="$4"
    local worker_output_dir="$5"
    
    # Gracefully stop any existing proxy on this specific port (SIGINT like Ctrl+C)
    pkill -2 -f "launch_proxy.sh.*$port" 2>/dev/null || true
    pkill -2 -f "quiche_server.*$port" 2>/dev/null || true
    sleep 0.3
    
    cd "$(dirname "$PROXY_SCRIPT")"
    
    # Build proxy command arguments using new launch_proxy.sh format
    local proxy_args=("-i" "$interface")
    if [[ -n "$migrate_interface" ]]; then
        proxy_args+=("-m" "$migrate_interface")
    fi
    proxy_args+=("-p" "$port")
    if [[ "$PV_MIGRATION" == "true" ]]; then
        proxy_args+=("-w")
    fi
    # Use -l option to save connection details from proxy itself
    proxy_args+=("-l" "worker_${worker_id}")
    
    # Start proxy in background
    local proxy_log="$worker_output_dir/proxy_worker_${worker_id}.log"
    nohup "$PROXY_SCRIPT" "${proxy_args[@]}" > "$proxy_log" 2>&1 &
    local proxy_pid=$!
    
    # Wait for proxy to start on the custom port
    local attempts=0
    while [[ $attempts -lt 30 ]]; do
        if nc -z localhost "$port" 2>/dev/null; then
            return 0  # Success
        fi
        sleep 0.5
        attempts=$((attempts + 1))
    done
    
    return 1  # Failed to start
}

stop_proxy_worker() {
    local port="$1"
    local worker_id="$2"
    
    # Gracefully stop both wrapper and server (SIGINT to save logs)
    pkill -2 -f "launch_proxy.sh.*$port" 2>/dev/null || true
    pkill -2 -f "quiche_server.*worker_${worker_id}" 2>/dev/null || true
    
    # Wait for graceful shutdown and JSON file creation
    sleep 1
}

# Run parallel worker process
run_parallel_worker() {
    local worker_id="$1"
    local chunk_file="$2"
    local interface="$3"
    local migrate_interface="$4"
    local worker_port="$5"
    local worker_output_dir="$6"
    
    local worker_log="$worker_output_dir/worker_${worker_id}.log"
    local worker_csv="$worker_output_dir/worker_${worker_id}_results.csv"
    
    # Worker-specific logging
    worker_log() {
        local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
        echo "[$timestamp] [Worker-$worker_id] $1" >> "$worker_log"
    }
    
    worker_log "Starting parallel worker $worker_id"
    worker_log "Chunk file: $chunk_file"
    worker_log "Proxy port: $worker_port (dedicated instance)"
    worker_log "Interface: $interface${migrate_interface:+ -> $migrate_interface}"
    
    local domains=($(cat "$chunk_file"))
    local total_chunk_domains=${#domains[@]}
    
    # Start from the beginning
    local resume_from=1
    
    worker_log "Processing $total_chunk_domains domains with $NUM_RUNS runs each (starting from index $resume_from)"
    
    # Apply resume offset
    if [[ $resume_from -gt 1 ]]; then
        domains=("${domains[@]:$((resume_from-1))}")
    fi
    
    local success_count=0
    local failed_count=0
    
    # Process each domain in the chunk
    local current=0
    for domain in "${domains[@]}"; do
        current=$((current + 1))
        local global_index=$((resume_from + current - 1))
        
        worker_log "[$current/${#domains[@]}] Testing: $domain (Global: #$global_index)"
        
        # Test domain based on mode (Paired or regular runs)
        local domain_success=false
        if [[ "$PAIR_MODE" == "true" && -n "$migrate_interface" ]]; then
            # Regular Paired mode
            worker_log "Paired mode: $NUM_RUNS runs per phase"
            if test_domain_paired "$domain" "$global_index" "$interface" "$migrate_interface" "$NUM_RUNS" "$worker_id" "$worker_port"; then
                domain_success=true
                worker_log "[$current/${#domains[@]}] Paired analysis completed: $domain"
            else
                worker_log "[$current/${#domains[@]}] Paired analysis failed: $domain"
            fi
        else
            # Regular mode - Test domain multiple times as specified by NUM_RUNS
            for ((run=1; run<=NUM_RUNS; run++)); do
                if [[ $NUM_RUNS -gt 1 ]]; then
                    worker_log "  Run $run/$NUM_RUNS for $domain"
                fi
                
                # Start proxy for this run
                if ! start_proxy_worker "$interface" "$migrate_interface" "$worker_port" "$worker_id" "$worker_output_dir"; then
                    worker_log "Failed to start proxy for $domain run $run"
                    continue
                fi
                
                # Calculate report port for this worker (same as in start_proxy_worker)
                local report_port=$((9090 + worker_id * 10))
                
                # Run test with custom proxy port and report port
                cd "$CLIENT_SCRIPT_DIR"
                if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$worker_csv" --url="$domain" >> "$worker_log" 2>&1; then
                    domain_success=true
                    worker_log "Run $run/$NUM_RUNS completed for $domain"
                else
                    worker_log "Run $run/$NUM_RUNS failed for $domain"
                fi
                
                # Stop proxy after each run
                stop_proxy_worker "$worker_port" "$worker_id"
                
                # Log proxy statistics from JSON files
                log_proxy_stats "$domain" "worker_${worker_id}"
                
                sleep 0.2  # Brief pause between runs
            done
        fi
        
        if [[ $domain_success == true ]]; then
            success_count=$((success_count + 1))
            if [[ "$PAIR_MODE" == "true" ]]; then
                worker_log "Paired analysis completed: $domain"
            else
                worker_log "Domain completed: $domain"
            fi
        else
            failed_count=$((failed_count + 1))
            if [[ "$PAIR_MODE" == "true" ]]; then
                worker_log "Paired analysis failed: $domain"
            else
                worker_log "Domain failed: $domain"
            fi
        fi
    done
    
    worker_log "Worker $worker_id completed: $success_count successful, $failed_count failed"
    echo "$success_count $failed_count" > "$worker_output_dir/worker_${worker_id}_stats.txt"
}

# Aggregate results from parallel workers
aggregate_parallel_results() {
    local worker_output_dir="$1"
    local final_csv="$2"
    local interface_suffix="$3"
    
    log "Aggregating results from parallel workers..."
    
    # Find all worker CSV files
    local worker_csvs=($(find "$worker_output_dir" -name "worker_*_results.csv" | sort))
    local total_success=0
    local total_failed=0
    
    if [[ ${#worker_csvs[@]} -eq 0 ]]; then
        error_log "No worker CSV files found for aggregation"
        return 1
    fi
    
    # Create final CSV with header from first worker file
    local first_csv="${worker_csvs[0]}"
    if [[ -f "$first_csv" ]]; then
        head -n 1 "$first_csv" > "$final_csv"
        log "Created final CSV header: $final_csv"
    fi
    
    # Aggregate data from all workers
    for worker_csv in "${worker_csvs[@]}"; do
        if [[ -f "$worker_csv" ]]; then
            local worker_id=$(basename "$worker_csv" | sed 's/worker_\([0-9]*\)_results.csv/\1/')
            local data_lines=$(tail -n +2 "$worker_csv" | wc -l)
            
            if [[ $data_lines -gt 0 ]]; then
                tail -n +2 "$worker_csv" >> "$final_csv"
                log "  Merged $data_lines results from worker $worker_id"
            fi
            
            # Get worker stats
            local stats_file="$worker_output_dir/worker_${worker_id}_stats.txt"
            if [[ -f "$stats_file" ]]; then
                local worker_stats=($(cat "$stats_file"))
                total_success=$((total_success + ${worker_stats[0]:-0}))
                total_failed=$((total_failed + ${worker_stats[1]:-0}))
            fi
        fi
    done
    
    log "Aggregation complete: $total_success successful, $total_failed failed"
    log "Final results: $final_csv"
    
    # Cleanup worker files
    log "Cleaning up worker files..."
    rm -f "$worker_output_dir"/worker_*.csv
    rm -f "$worker_output_dir"/worker_*_stats.txt
    rm -f "$worker_output_dir"/chunk_*.txt
}

# Main parallel execution function
run_parallel_scan() {
    local interface="$1" 
    local migrate_interface="$2"
    
    log "Starting parallel scan with $PARALLEL_JOBS workers"
    log "Interface: $interface${migrate_interface:+ -> $migrate_interface}"
    
    # Create worker output directory
    local worker_output_dir="$TIMESTAMPED_OUTPUT_DIR/parallel_workers"
    mkdir -p "$worker_output_dir"
    
    # Divide domains into chunks
    divide_domains "$INPUT_FILE" "$PARALLEL_JOBS" "$worker_output_dir"
    local chunk_files=("${CHUNK_FILES[@]}")
    local actual_workers=${#chunk_files[@]}
    
    if [[ $actual_workers -lt $PARALLEL_JOBS ]]; then
        log "Adjusted to $actual_workers workers (fewer than requested due to domain count)"
    fi
    
    # Generate random ports for each worker
    local worker_ports=()
    for ((i=1; i<=actual_workers; i++)); do
        local port=$(generate_random_port)
        # Ensure port is unique
        while [[ " ${worker_ports[@]} " =~ " $port " ]]; do
            port=$(generate_random_port)
        done
        worker_ports+=("$port")
    done
    
    log "Generated worker ports: ${worker_ports[*]}"
    
    # Start parallel workers
    local worker_pids=()
    for ((i=0; i<actual_workers; i++)); do
        local worker_id=$((i + 1))
        local chunk_file="${chunk_files[$i]}"
        local worker_port="${worker_ports[$i]}"
        
        log "Starting worker $worker_id (port $worker_port, chunk: $(basename "$chunk_file"))"
        
        # Run worker in background
        run_parallel_worker "$worker_id" "$chunk_file" "$interface" "$migrate_interface" "$worker_port" "$worker_output_dir" &
        worker_pids+=($!)
    done
    
    log "Waiting for $actual_workers parallel workers to complete..."
    
    # Wait for all workers to complete
    local completed=0
    for pid in "${worker_pids[@]}"; do
        if wait "$pid"; then
            completed=$((completed + 1))
            log "Worker completed successfully ($completed/$actual_workers)"
        else
            error_log "Worker failed (PID: $pid)"
        fi
    done
    
    # Aggregate results
    local interface_suffix
    if [[ -n "$migrate_interface" ]]; then
        interface_suffix="${interface}_migrate_${migrate_interface}"
    else
        interface_suffix="$interface"
    fi
    
    # If migration mode (paired), use merge_worker_averages, otherwise use regular aggregation
    if [[ -n "$migrate_interface" ]]; then
        log "Running merge for baseline/migration results (migrate='$migrate_interface')"
        merge_worker_averages "$TIMESTAMPED_OUTPUT_DIR" "$interface" "$migrate_interface"
    else
        local final_csv="${CSV_FILE}_${interface_suffix}.csv"
        aggregate_parallel_results "$worker_output_dir" "$final_csv" "$interface_suffix"
    fi
    
    log "Parallel scan completed with $actual_workers workers"
}

# ── Proxy Management ─────────────────────────────────────────────────────────
start_proxy() {
    local interface="$1"
    local migrate_interface="$2"
    
    if [[ -n "$migrate_interface" ]]; then
        log "Starting QUIC proxy ($interface -> $migrate_interface migration)..."
    else
        log "Starting QUIC proxy ($interface)..."
    fi
    
    # Gracefully stop any existing proxy (SIGINT like Ctrl+C)
    pkill -2 -f "launch_proxy.sh" 2>/dev/null || true
    pkill -2 -f "quiche_server" 2>/dev/null || true
    sleep 0.3
    
    # Start proxy in background with specified interface and optional migration
    cd "$(dirname "$PROXY_SCRIPT")"
    
    # Build proxy command arguments using new launch_proxy.sh format
    local proxy_args=("-i" "$interface")
    if [[ -n "$migrate_interface" ]]; then
        proxy_args+=("-m" "$migrate_interface")
    fi
    if [[ "$PV_MIGRATION" == "true" ]]; then
        proxy_args+=("-w")
    fi
    # Use -l option to save connection details from proxy itself
    proxy_args+=("-l" "main_proxy")
    
    if [[ -n "$migrate_interface" ]]; then
        nohup "$PROXY_SCRIPT" "${proxy_args[@]}" > "$TIMESTAMPED_OUTPUT_DIR/proxy_${interface}_migrate_${migrate_interface}.log" 2>&1 &
    else
        nohup "$PROXY_SCRIPT" "${proxy_args[@]}" > "$TIMESTAMPED_OUTPUT_DIR/proxy_${interface}.log" 2>&1 &
    fi
    PROXY_PID=$!
    
    # Wait longer for Rust process to compile and start
    sleep 1
    
    # Check if quiche_server process is running (the actual Rust process)
    if pgrep -f "quiche_server" > /dev/null; then
        ACTUAL_PID=$(pgrep -f "quiche_server")
        if [[ -n "$migrate_interface" ]]; then
            log "Proxy started successfully with $interface -> $migrate_interface migration (Script PID: $PROXY_PID, Server PID: $ACTUAL_PID)"
        else
            log "Proxy started successfully with $interface (Script PID: $PROXY_PID, Server PID: $ACTUAL_PID)"
        fi
        return 0
    else
        if [[ -n "$migrate_interface" ]]; then
            error_log "Failed to start proxy with $interface -> $migrate_interface migration - quiche_server process not found"
            error_log "Last proxy log output:"
            tail -10 "$TIMESTAMPED_OUTPUT_DIR/proxy_${interface}_migrate_${migrate_interface}.log" | while read line; do
                error_log "  $line"
            done
        else
            error_log "Failed to start proxy with $interface - quiche_server process not found"
            error_log "Last proxy log output:"
            tail -10 "$TIMESTAMPED_OUTPUT_DIR/proxy_${interface}.log" | while read line; do
                error_log "  $line"
            done
        fi
        return 1
    fi
}

stop_proxy() {
    log "Stopping QUIC proxy..."
    
    # Gracefully stop both wrapper script and server (SIGINT to save logs)
    pkill -2 -f "launch_proxy.sh" 2>/dev/null || true
    pkill -2 -f "quiche_server" 2>/dev/null || true
    
    # Wait for graceful shutdown and JSON file creation
    sleep 1
    
    log "Proxy stopped"
}

# Log proxy statistics from JSON files after proxy shutdown
log_proxy_stats() {
    local domain="$1"
    local log_prefix="$2"  # e.g., "main_proxy" or "worker_1"
    local proxy_dir="$(dirname "$PROXY_SCRIPT")"
    
    # JSON files created by proxy on SIGINT
    local results_json="${proxy_dir}/${log_prefix}_results.json"
    
    # Wait for JSON file to be written
    local wait_count=0
    while [[ $wait_count -lt 10 ]]; do
        if [[ -f "$results_json" ]]; then
            break
        fi
        sleep 0.2
        wait_count=$((wait_count + 1))
    done
    
    # Check if file exists
    if [[ ! -f "$results_json" ]]; then
        log "[$domain] Proxy JSON not found: $results_json"
        return 1
    fi
    
    # Parse with jq if available
    if command -v jq &> /dev/null; then
        local total_streams=$(jq -r '.[0].total_streams // 0' "$results_json" 2>/dev/null || echo "0")
        local total_data=$(jq -r '.[0].total_content_length // 0' "$results_json" 2>/dev/null || echo "0")
        local total_migrated=$(jq -r '.[0].total_migrated // 0' "$results_json" 2>/dev/null || echo "0")
        local entry_status=$(jq -r '.[0].entry_status // "unknown"' "$results_json" 2>/dev/null || echo "unknown")
        local disable_cm=$(jq -r '.[0].disable_cm // false' "$results_json" 2>/dev/null || echo "false")
        local stateless=$(jq -r '.[0].stateless // false' "$results_json" 2>/dev/null || echo "false")
        
        # Calculate rate
        local rate="0"
        if [[ $total_data -gt 0 ]]; then
            rate=$(echo "scale=2; ($total_migrated * 100) / $total_data" | bc 2>/dev/null || echo "0")
        fi
        
        log "[$domain] Proxy stats: status=$entry_status, streams=$total_streams, data=$total_data bytes, migrated=$total_migrated bytes (${rate}%), disable_cm=$disable_cm, stateless=$stateless"
    else
        log "[$domain] jq not installed - cannot parse proxy stats. Install: sudo apt-get install jq"
    fi
    
    return 0
}

check_proxy_health() {
    # Check if quiche_server is running and proxy port is responding
    if ! pgrep -f "quiche_server" > /dev/null; then
        return 1
    fi
    
    # Try to connect to proxy port (basic check)
    if ! nc -z localhost 4433 2>/dev/null; then
        return 1
    fi
    
    return 0
}

# Paired mode testing: baseline + migration phases with regular runs
test_domain_paired() {
    local domain="$1"
    local index="$2"
    local interface="$3"
    local migrate_interface="$4"
    local num_runs="$5"
    local worker_id="${6:-""}"
    local worker_port="${7:-""}"
    
    log "[$index] Starting paired analysis for: $domain ($num_runs runs per phase)"
    
    # Create phase-specific CSV files
    local worker_suffix=""
    if [[ -n "$worker_id" ]]; then
        worker_suffix="_worker_${worker_id}"
    fi
    
    local worker_dir="${TIMESTAMPED_OUTPUT_DIR}/parallel_workers"
    mkdir -p "$worker_dir"
    
    local baseline_csv="${worker_dir}/baseline_run_${interface}${worker_suffix}.csv"
    local migration_csv="${worker_dir}/migration_run_${interface}_to_${migrate_interface}${worker_suffix}.csv"
    
    # ── Phase 1: Baseline (no migration) ──
    log "[$index] Phase 1: Baseline analysis for $domain ($num_runs runs)"
    
    # Temporarily disable migration for baseline
    local original_migrate="$migrate_interface"
    migrate_interface=""
    
    local baseline_success_count=0
    for ((run=1; run<=num_runs; run++)); do
        log "  [$index] Baseline run $run/$num_runs for $domain"
        
        # Start proxy for baseline run
        if [[ -n "$worker_port" ]]; then
            if ! start_proxy_worker "$interface" "" "$worker_port" "$worker_id" "$(dirname "$baseline_csv")"; then
                error_log "Failed to start worker proxy for baseline run $run of $domain"
                continue
            fi
        else
            if ! start_proxy "$interface" ""; then
                error_log "Failed to start proxy for baseline run $run of $domain"
                continue
            fi
        fi
        
        # Run baseline test
        cd "$CLIENT_SCRIPT_DIR"
        local baseline_success=false
        if [[ -n "$worker_port" ]]; then
            local report_port=$((9090 + worker_id * 10))
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$baseline_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                baseline_success=true
            fi
        else
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$baseline_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                baseline_success=true
            fi
        fi
        
        if [[ "$baseline_success" == "true" ]]; then
            baseline_success_count=$((baseline_success_count + 1))
            log "  [$index] Baseline run $run successful"
        else
            log "  [$index] Baseline run $run failed"
        fi
        
        # Stop proxy after each run
        if [[ -n "$worker_port" ]]; then
            stop_proxy_worker "$worker_port" "$worker_id"
            log_proxy_stats "$domain" "worker_${worker_id}"
        else
            stop_proxy
            log_proxy_stats "$domain" "main_proxy"
        fi
        
        sleep 0.2
    done
    
    if [[ $baseline_success_count -eq 0 ]]; then
        log "[$index] No successful baseline runs for $domain - skipping migration analysis"
        return 1
    fi
    
    log "[$index] Phase 1 completed: $baseline_success_count/$num_runs successful baseline runs"
    
    # ── Phase 2: Migration Analysis ──
    log "[$index] Phase 2: Migration analysis for $domain ($num_runs runs)"
    
    # Restore migration settings
    migrate_interface="$original_migrate"
    
    local migration_success_count=0
    for ((run=1; run<=num_runs; run++)); do
        log "  [$index] Migration run $run/$num_runs for $domain"
        
        # Start proxy with migration
        if [[ -n "$worker_port" ]]; then
            if ! start_proxy_worker "$interface" "$migrate_interface" "$worker_port" "$worker_id" "$(dirname "$migration_csv")"; then
                error_log "Failed to start worker proxy for migration run $run of $domain"
                continue
            fi
        else
            if ! start_proxy "$interface" "$migrate_interface"; then
                error_log "Failed to start proxy for migration run $run of $domain"
                continue
            fi
        fi
        
        # Run migration test
        cd "$CLIENT_SCRIPT_DIR"
        local migration_success=false
        if [[ -n "$worker_port" ]]; then
            local report_port=$((9090 + worker_id * 10))
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                migration_success=true
            fi
        else
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                migration_success=true
            fi
        fi
        
        if [[ "$migration_success" == "true" ]]; then
            migration_success_count=$((migration_success_count + 1))
            log "  [$index] Migration run $run successful"
        else
            log "  [$index] Migration run $run failed"
        fi
        
        # Stop proxy after each run
        if [[ -n "$worker_port" ]]; then
            stop_proxy_worker "$worker_port" "$worker_id"
            log_proxy_stats "$domain" "worker_${worker_id}"
        else
            stop_proxy
            log_proxy_stats "$domain" "main_proxy"
        fi
        
        sleep 0.2
    done
    
    log "[$index] Phase 2 completed: $migration_success_count/$num_runs successful migration runs"
    
    if [[ $migration_success_count -gt 0 ]]; then
        log "[$index] Paired analysis completed successfully for $domain"
        return 0
    else
        log "[$index] Paired analysis failed for $domain (no successful migration runs)"
        return 1
    fi
}
# Function to merge worker average files into final summary
merge_worker_averages() {
    local output_dir="$1"
    local interface="$2"
    local migrate_interface="$3"
    
    log "Merging worker average files..."
    
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local final_averages="${output_dir}/${timestamp}_final_averages.csv"
    local final_unstable="${output_dir}/${timestamp}_final_unstable_domains.csv"
    
    # Create headers for final files
    echo "SNI,ip_addr,main_first_status,median_load_time_only,avg_load_time_only,median_total_data_amount_only,avg_total_data_amount_only,median_load_time_migrated,avg_load_time_migrated,median_total_data_amount_migrated,avg_total_data_amount_migrated,migrated_domains_averaged,dominant_migrated_domain" > "$final_averages"
    echo "SNI,phase,reason,attempted_runs" > "$final_unstable"
    
    # Look for worker files in the parallel_workers directory
    local worker_dir="${output_dir}/parallel_workers"
    
    # Merge all worker average files
    local merged_count=0
    for worker_avg in "$worker_dir"/*_averages_worker_*.csv; do
        if [[ -f "$worker_avg" ]]; then
            tail -n +2 "$worker_avg" >> "$final_averages"
            merged_count=$((merged_count + 1))
            log "  Merged averages from: $(basename "$worker_avg")"
        fi
    done
    
    # Merge all worker unstable domain files  
    local unstable_count=0
    for worker_unstable in "$worker_dir"/*_unstable_domains_worker_*.csv; do
        if [[ -f "$worker_unstable" ]]; then
            tail -n +2 "$worker_unstable" >> "$final_unstable"
            unstable_count=$((unstable_count + 1))
            log "  Merged unstable domains from: $(basename "$worker_unstable")"
        fi
    done
    
    # Also merge phase-specific CSV files (final results go in main directory)
    local baseline_final="${output_dir}/baseline_result_${interface}.csv"
    local migration_final="${output_dir}/migration_result_${interface}_to_${migrate_interface}.csv"
    
    # Merge baseline phase results
    local baseline_merged=0
    if ls "$worker_dir"/baseline_run_${interface}_worker_*.csv 1> /dev/null 2>&1; then
        # Get header from first file
        local first_baseline=$(ls "$worker_dir"/baseline_run_${interface}_worker_*.csv | head -1)
        if [[ -f "$first_baseline" ]]; then
            head -1 "$first_baseline" > "$baseline_final"
            for worker_baseline in "$worker_dir"/baseline_run_${interface}_worker_*.csv; do
                if [[ -f "$worker_baseline" ]]; then
                    tail -n +2 "$worker_baseline" >> "$baseline_final"
                    baseline_merged=$((baseline_merged + 1))
                fi
            done
        fi
    fi
    
    # Merge migration phase results  
    local migration_merged=0
    if ls "$worker_dir"/migration_run_${interface}_to_${migrate_interface}_worker_*.csv 1> /dev/null 2>&1; then
        local first_migration=$(ls "$worker_dir"/migration_run_${interface}_to_${migrate_interface}_worker_*.csv | head -1)
        if [[ -f "$first_migration" ]]; then
            head -1 "$first_migration" > "$migration_final"
            for worker_migration in "$worker_dir"/migration_run_${interface}_to_${migrate_interface}_worker_*.csv; do
                if [[ -f "$worker_migration" ]]; then
                    tail -n +2 "$worker_migration" >> "$migration_final"
                    migration_merged=$((migration_merged + 1))
                fi
            done
        fi
    fi
    
    log "Final merge results:"
    log "  - Average files merged: $merged_count workers"  
    log "  - Unstable domain files merged: $unstable_count workers"
    log "  - Baseline phase files merged: $baseline_merged workers → $baseline_final"
    log "  - Migration phase files merged: $migration_merged workers → $migration_final"
    log "  - Final averages: $final_averages"
    log "  - Final unstable domains: $final_unstable"
}

# ── Client Testing ─────────────────────────────────────────────────────────────────────────────────────────
# No-proxy version of test_domain function
test_domain_no_proxy() {
    local domain="$1"
    local index="$2"
    local suffix="$3"
    
    log "[$index] Testing domain: $domain (direct connection, $NUM_RUNS runs)"
    
    # Run multiple tests for this domain without proxy
    local success_count=0
    local run_number=1
    
    cd "$CLIENT_SCRIPT_DIR"
    
    while [[ $run_number -le $NUM_RUNS ]]; do
        if [[ $NUM_RUNS -gt 1 ]]; then
            log "  [$index] Run $run_number/$NUM_RUNS for $domain (direct connection)"
        fi
        
        # Execute the test without proxy
        local test_success=false
        if timeout "$TIMEOUT" bash -c "cd '$CLIENT_SCRIPT_DIR' && node '$CLIENT_SCRIPT' --csv='${CSV_FILE}_${suffix}.csv' --url='$domain'" 2>&1 | tee -a "$LOG_FILE"; then
            success_count=$((success_count + 1))
            test_success=true
            if [[ $NUM_RUNS -gt 1 ]]; then
                log "  [$index] Run $run_number/$NUM_RUNS completed for $domain (direct connection)"
            fi
        else
            if [[ $NUM_RUNS -gt 1 ]]; then
                error_log "Run $run_number/$NUM_RUNS failed for $domain (direct connection): execution failed or timed out"
            fi
        fi
        
        # Small delay between runs (except for the last one)
        if [[ $run_number -lt $NUM_RUNS ]]; then
            sleep 0.2
        fi
        
        run_number=$((run_number + 1))
    done
    
    # Report overall success for this domain
    if [[ $success_count -gt 0 ]]; then
        log "[$index] Domain completed: $domain ($success_count/$NUM_RUNS successful runs, direct connection)"
    else
        error_log "All runs failed for $domain (direct connection)"
    fi
    
    # Small delay between domains
    sleep 0.2
    
    # Return success if at least one run succeeded
    return $([[ $success_count -gt 0 ]] && echo 0 || echo 1)
}

test_domain() {
    local domain="$1"
    local index="$2"
    local interface="$3"
    local migrate_interface="$4"
    
    if [[ -n "$migrate_interface" ]]; then
        log "[$index] Testing domain: $domain (using $interface -> $migrate_interface migration, $NUM_RUNS runs)"
    else
        log "[$index] Testing domain: $domain (using $interface, $NUM_RUNS runs)"
    fi
    
    # Generate appropriate CSV filename
    local csv_suffix
    if [[ -n "$migrate_interface" ]]; then
        csv_suffix="${interface}_migrate_${migrate_interface}"
    else
        csv_suffix="$interface"
    fi
    
    # Run multiple tests for this domain with fresh proxy each time
    local success_count=0
    local run_number=1
    
    cd "$CLIENT_SCRIPT_DIR"
    
    while [[ $run_number -le $NUM_RUNS ]]; do
        if [[ $NUM_RUNS -gt 1 ]]; then
            if [[ -n "$migrate_interface" ]]; then
                log "  [$index] Run $run_number/$NUM_RUNS for $domain (using $interface -> $migrate_interface migration) - Starting fresh proxy+client"
            else
                log "  [$index] Run $run_number/$NUM_RUNS for $domain (using $interface) - Starting fresh proxy+client"
            fi
        fi
        
        # START FRESH PROXY FOR EACH RUN
        if ! start_proxy "$interface" "$migrate_interface"; then
            if [[ -n "$migrate_interface" ]]; then
                error_log "Failed to start proxy for $domain run $run_number/$NUM_RUNS (using $interface -> $migrate_interface migration)"
            else
                error_log "Failed to start proxy for $domain run $run_number/$NUM_RUNS (using $interface)"
            fi
            
            # Stop any partial proxy and continue to next run
            stop_proxy
            run_number=$((run_number + 1))
            continue
        fi
        
        # Additional health check
        if ! check_proxy_health; then
            if [[ -n "$migrate_interface" ]]; then
                error_log "Proxy health check failed for $domain run $run_number/$NUM_RUNS (using $interface -> $migrate_interface migration)"
            else
                error_log "Proxy health check failed for $domain run $run_number/$NUM_RUNS (using $interface)"
            fi
            stop_proxy
            run_number=$((run_number + 1))
            continue
        fi
        
        # Execute the test with timeout against fresh proxy (ensure correct working directory)
        local test_success=false
        if timeout "$TIMEOUT" bash -c "cd '$CLIENT_SCRIPT_DIR' && node '$CLIENT_SCRIPT' --use-proxy --csv='${CSV_FILE}_${csv_suffix}.csv' --url='$domain'" 2>&1 | tee -a "$LOG_FILE"; then
            success_count=$((success_count + 1))
            test_success=true
            if [[ $NUM_RUNS -gt 1 ]]; then
                if [[ -n "$migrate_interface" ]]; then
                    log "  [$index] Run $run_number/$NUM_RUNS completed for $domain (using $interface -> $migrate_interface migration)"
                else
                    log "  [$index] Run $run_number/$NUM_RUNS completed for $domain (using $interface)"
                fi
            fi
        else
            if [[ $NUM_RUNS -gt 1 ]]; then
                if [[ -n "$migrate_interface" ]]; then
                    error_log "Run $run_number/$NUM_RUNS failed for $domain (using $interface -> $migrate_interface migration): execution failed or timed out"
                else
                    error_log "Run $run_number/$NUM_RUNS failed for $domain (using $interface): execution failed or timed out"
                fi
            fi
        fi
        
        # ALWAYS STOP PROXY AFTER EACH RUN
        log "  Stopping proxy after run $run_number/$NUM_RUNS"
        stop_proxy
        
        # Log proxy statistics from JSON files
        log_proxy_stats "$domain" "main_proxy"
        
        # Small delay between runs (except for the last one)
        if [[ $run_number -lt $NUM_RUNS ]]; then
            sleep 0.2  # Delay to ensure proxy fully stops
        fi
        
        run_number=$((run_number + 1))
    done
    
    # Report overall success for this domain
    if [[ $success_count -gt 0 ]]; then
        if [[ -n "$migrate_interface" ]]; then
            log "[$index] Domain completed: $domain ($success_count/$NUM_RUNS successful runs, using $interface -> $migrate_interface migration)"
        else
            log "[$index] Domain completed: $domain ($success_count/$NUM_RUNS successful runs, using $interface)"
        fi
    else
        if [[ -n "$migrate_interface" ]]; then
            error_log "All runs failed for $domain (using $interface -> $migrate_interface migration)"
        else
            error_log "All runs failed for $domain (using $interface)"
        fi
    fi
    
    # Small delay between domains
    sleep 0.2
    
    # Return success if at least one run succeeded
    return $([[ $success_count -gt 0 ]] && echo 0 || echo 1)
}

# ── Main Scanning Logic ──────────────────────────────────────────────────────
# No-proxy version of run_scan
run_scan_no_proxy() {
    local suffix="$1"
    local domains=($(cat "$INPUT_FILE"))
    local total_domains=${#domains[@]}
    
    # Apply start offset
    if [[ $START_FROM -gt 1 ]]; then
        domains=("${domains[@]:$((START_FROM-1))}")
        log "Starting from domain #$START_FROM (direct connection)"
    fi
    
    # Apply max limit
    if [[ $MAX_DOMAINS -gt 0 && $MAX_DOMAINS -lt ${#domains[@]} ]]; then
        domains=("${domains[@]:0:$MAX_DOMAINS}")
        log "📏 Limited to $MAX_DOMAINS domains (direct connection)"
    fi
    
    local scan_count=${#domains[@]}
    log "Scanning $scan_count domains using direct connection (total in file: $total_domains)"
    
    # Sequential scanning
    local current=0
    for domain in "${domains[@]}"; do
        current=$((current + 1))
        local global_index=$((START_FROM + current - 1))
        
        log "Progress (direct): $current/$scan_count (Global: #$global_index) - $domain"
        
        if test_domain_no_proxy "$domain" "$global_index" "$suffix"; then
            log "[$global_index] Completed: $domain (direct connection)"
        else
            error_log "Failed: $domain (direct connection)"
        fi
        
        # Progress indicator
        if [[ $((current % 10)) -eq 0 ]]; then
            log "Progress: $current/$scan_count domains completed"
        fi
    done
    
    log "Completed all scans using direct connection"
}

run_scan() {
    local interface="$1"
    local migrate_interface="$2"
    local domains=($(cat "$INPUT_FILE"))
    local total_domains=${#domains[@]}
    
    # Apply start offset
    if [[ $START_FROM -gt 1 ]]; then
        domains=("${domains[@]:$((START_FROM-1))}")
        if [[ -n "$migrate_interface" ]]; then
            log "Starting from domain #$START_FROM for $interface -> $migrate_interface migration"
        else
            log "Starting from domain #$START_FROM for $interface"
        fi
    fi
    
    # Apply max limit
    if [[ $MAX_DOMAINS -gt 0 && $MAX_DOMAINS -lt ${#domains[@]} ]]; then
        domains=("${domains[@]:0:$MAX_DOMAINS}")
        if [[ -n "$migrate_interface" ]]; then
            log "Limited to $MAX_DOMAINS domains for $interface -> $migrate_interface migration"
        else
            log "Limited to $MAX_DOMAINS domains for $interface"
        fi
    fi
    
    local scan_count=${#domains[@]}
    if [[ -n "$migrate_interface" ]]; then
        log "Scanning $scan_count domains using $interface -> $migrate_interface migration (total in file: $total_domains)"
    else
        log "Scanning $scan_count domains using $interface (total in file: $total_domains)"
    fi
    
    # Sequential scanning (proxy doesn't support parallel well)
    local current=0
    for domain in "${domains[@]}"; do
        current=$((current + 1))
        local global_index=$((START_FROM + current - 1))
        
        if [[ -n "$migrate_interface" ]]; then
            log "Progress ($interface -> $migrate_interface): $current/$scan_count (Global: #$global_index) - $domain"
        else
            log "Progress ($interface): $current/$scan_count (Global: #$global_index) - $domain"
        fi
        
        # Regular mode
        if test_domain "$domain" "$global_index" "$interface" "$migrate_interface"; then
            if [[ -n "$migrate_interface" ]]; then
                log "[$global_index] Completed: $domain (using $interface -> $migrate_interface migration)"
            else
                log "[$global_index] Completed: $domain (using $interface)"
            fi
        else
            if [[ -n "$migrate_interface" ]]; then
                error_log "Failed: $domain (using $interface -> $migrate_interface migration)"
            else
                error_log "Failed: $domain (using $interface)"
            fi
        fi
        
        # Progress indicator
        if [[ $((current % 10)) -eq 0 ]]; then
            if [[ -n "$migrate_interface" ]]; then
                log "Progress ($interface -> $migrate_interface): $current/$scan_count domains completed"
            else
                log "Progress ($interface): $current/$scan_count domains completed"
            fi
        fi
    done
    
    if [[ -n "$migrate_interface" ]]; then
        log "Completed all scans using $interface -> $migrate_interface migration"
    else
        log "Completed all scans using $interface"
    fi
}

# ── Summary Generation ───────────────────────────────────────────────────────
generate_summary() {
    log "Generating summary report..."
    
    # Determine which CSV files to analyze based on the mode
    local csv_files=()
    local interface_names=()
    
    if [[ -n "$INTERFACE" ]]; then
        # Single interface mode
        if [[ -n "$MIGRATE" ]]; then
            # Check for migration result file created by merge process
            local migration_file="${TIMESTAMPED_OUTPUT_DIR}/migration_result_${INTERFACE}_to_${MIGRATE}.csv"
            if [[ -f "$migration_file" ]]; then
                csv_files=("$migration_file")
                interface_names=("$INTERFACE -> $MIGRATE migration")
            else
                # Fall back to old naming for compatibility
                local csv_file="${CSV_FILE}_${INTERFACE}_migrate_${MIGRATE}.csv"
                csv_files=("$csv_file")
                interface_names=("$INTERFACE -> $MIGRATE migration")
            fi
        else
            local csv_file="${CSV_FILE}_${INTERFACE}.csv"
            csv_files=("$csv_file")
            interface_names=("$INTERFACE")
        fi
    fi
    
    # Calculate execution time for summary
    local end_time=$(date +%s)
    local duration=$((end_time - SCRIPT_START_TIME))
    local domains_input_count=$(wc -l < "$INPUT_FILE" 2>/dev/null || echo "0")
    
    # Generate summary
    {
        echo "═══════════════════════════════════════════════════"
        echo "    QUIC Proxy - Client Scanner Summary"
        echo "═══════════════════════════════════════════════════"
        echo "Scan Date: $(date)"
        echo "Start Time: $START_TIME_DISPLAY"
        echo "End Time: $(date '+%Y-%m-%d %H:%M:%S')"
        echo "Total Execution Time: $(format_duration $duration)"
        echo ""
        echo "Configuration:"
        echo "  Input File: $(basename "$INPUT_FILE") ($domains_input_count domains)"
        echo "  Output Directory: $(basename "$OUTPUT_DIR")"
        echo "  Parallel Workers: $PARALLEL_JOBS"
        echo "  Timeout per Domain: ${TIMEOUT}s"
        echo "  Runs per Domain: $NUM_RUNS"
        echo "  Start Index: $START_FROM"
        if [[ $MAX_DOMAINS -gt 0 ]]; then
            echo "  Max Domains Limit: $MAX_DOMAINS"
        fi
        echo ""
        
        # Performance metrics
        local total_scanned=0
        local total_successful=0
        local total_failed=0
        
        # Statistics for each interface/mode
        for i in "${!csv_files[@]}"; do
            local csv_file="${csv_files[$i]}"
            local interface_name="${interface_names[$i]}"
            
            echo "$interface_name Interface Statistics:"
            if [[ -f "$csv_file" ]]; then
                local total_lines=$(wc -l < "$csv_file" 2>/dev/null || echo "1")
                local scans=$((total_lines - 1))  # Subtract header
                
                if [[ $scans -gt 0 ]]; then
                    local successful=$(tail -n +2 "$csv_file" 2>/dev/null | awk -F',' '$4!="FAILED"' | wc -l)
                    local failed=$(tail -n +2 "$csv_file" 2>/dev/null | awk -F',' '$4=="FAILED"' | wc -l)
                    local proxy_success=$(tail -n +2 "$csv_file" 2>/dev/null | awk -F',' '$18!~/failed|Failed/' | wc -l)
                    local connections=$(tail -n +2 "$csv_file" 2>/dev/null | awk -F',' '{sum+=$19} END {print sum+0}')
                    local data=$(tail -n +2 "$csv_file" 2>/dev/null | awk -F',' '{sum+=$20} END {print sum+0}')
                    local migrated=$(tail -n +2 "$csv_file" 2>/dev/null | awk -F',' '{sum+=$21} END {print sum+0}')
                    
                    # Format data amounts
                    local data_mb=$((data / 1024 / 1024))
                    local migrated_mb=$((migrated / 1024 / 1024))
                    
                    echo "  Total Domains Scanned: $scans"
                    echo "  Successful Scans: $successful"
                    echo "  Failed Scans: $failed"
                    echo "  Proxy Operations: $proxy_success successful"
                    echo "  Total Connections: $connections"
                    echo "  Total Data: $data bytes (${data_mb}MB)"
                    echo "  Migrated Data: $migrated bytes (${migrated_mb}MB)"
                    if [[ $scans -gt 0 ]]; then
                        local success_rate=$(( (successful * 100) / scans ))
                        echo "  Success Rate: ${success_rate}%"
                        
                        # Performance calculations
                        local avg_time_per_domain=$((duration / scans))
                        local domains_per_minute=$((scans * 60 / duration))
                        echo "  Average Time per Domain: ${avg_time_per_domain}s"
                        echo "  Processing Rate: ${domains_per_minute} domains/minute"
                    fi
                    
                    # Update totals
                    total_scanned=$((total_scanned + scans))
                    total_successful=$((total_successful + successful))
                    total_failed=$((total_failed + failed))
                else
                    echo "  No scans completed"
                fi
            else
                echo "  CSV file not found: $csv_file"
            fi
            echo ""
        done
        
        # Overall performance summary
        if [[ $total_scanned -gt 0 ]]; then
            echo "Overall Performance Summary:"
            echo "  Total Domains Processed: $total_scanned"
            echo "  Overall Success Rate: $(( (total_successful * 100) / total_scanned ))%"
            echo "  Total Execution Time: $(format_duration $duration)"
            echo "  Average Time per Domain: $((duration / total_scanned))s"
            echo "  Processing Throughput: $((total_scanned * 60 / duration)) domains/minute"
            if [[ $PARALLEL_JOBS -gt 1 ]]; then
                echo "  Parallel Efficiency: $PARALLEL_JOBS workers"
                local theoretical_sequential_time=$((total_scanned * 10))  # Estimate 10s per domain sequential
                local time_saved=$((theoretical_sequential_time - duration))
                if [[ $time_saved -gt 0 ]]; then
                    local efficiency=$(( (time_saved * 100) / theoretical_sequential_time ))
                    echo "  Estimated Time Saved: $(format_duration $time_saved) (~${efficiency}%)"
                fi
            fi
            echo ""
        fi
        
        echo "Output Files:"
        for csv_file in "${csv_files[@]}"; do
            if [[ -f "$csv_file" ]]; then
                local file_size=$(du -h "$csv_file" | cut -f1)
                echo "Results: $csv_file ($file_size)"
            fi
        done
        echo "  Scan Log: $LOG_FILE"
        echo "  Summary: $SUMMARY_FILE"
        
        # Additional files for parallel execution
        if [[ $PARALLEL_JOBS -gt 1 ]] && [[ -d "$TIMESTAMPED_OUTPUT_DIR/parallel_workers" ]]; then
            echo "   Worker Logs: $TIMESTAMPED_OUTPUT_DIR/parallel_workers/"
        fi
        
        echo "═══════════════════════════════════════════════════"
    } > "$SUMMARY_FILE"
    
    # Display summary
    cat "$SUMMARY_FILE"
}

# ── Cleanup ──────────────────────────────────────────────────────────────────
cleanup() {
    local end_time=$(date +%s)
    local duration=$((end_time - SCRIPT_START_TIME))
    local end_time_display=$(date '+%Y-%m-%d %H:%M:%S')
    
    log "Cleaning up..."
    
    # Enhanced proxy cleanup
    stop_proxy
    
    # Stop any worker proxies gracefully (SIGINT)
    log "Stopping all proxy processes..."
    pkill -2 -f "launch_proxy.sh" 2>/dev/null || true
    pkill -2 -f "quiche_server" 2>/dev/null || true
    
    # Wait for graceful shutdown
    sleep 2
    
    # Clean up temporary files
    rm -f "$TIMESTAMPED_OUTPUT_DIR"/temp_*.csv
    
    # Display execution time
    log "Execution Summary:"
    log "   Start time: $START_TIME_DISPLAY"
    log "   End time: $end_time_display"
    log "   Total duration: $(format_duration $duration)"
    
    generate_summary
}

# Enhanced signal handling
cleanup_on_interrupt() {
    log "Interrupted by user - performing cleanup..."
    cleanup
    exit 130
}

# Trap multiple signals for better cleanup
trap cleanup EXIT
trap cleanup_on_interrupt INT TERM

# ── Main Execution ───────────────────────────────────────────────────────────
main() {
    log "Starting QUIC Bypassing Scanner"
    log "Start time: $START_TIME_DISPLAY"
    log "Input: $INPUT_FILE"
    log "Output: $TIMESTAMPED_OUTPUT_DIR"
    log "Timestamp: $TIMESTAMP"
    log "Log file: $LOG_FILE"
    log "Configuration: start=$START_FROM, max=$MAX_DOMAINS, parallel=$PARALLEL_JOBS, timeout=${TIMEOUT}s, runs_per_domain=$NUM_RUNS"
    
    if [[ "$NO_PROXY" == "true" ]]; then
        log "Mode: Direct connection (no proxy)"
        log "CSV file: ${CSV_FILE}_direct.csv"
    elif [[ -n "$INTERFACE" ]]; then
        if [[ -n "$MIGRATE" ]]; then
            log "Mode: Single interface with migration ($INTERFACE -> $MIGRATE)"
            log "CSV file: ${CSV_FILE}_${INTERFACE}_migrate_${MIGRATE}.csv"
        else
            log "Mode: Single interface ($INTERFACE)"
            log "CSV file: ${CSV_FILE}_${INTERFACE}.csv"
        fi
        if [[ $PARALLEL_JOBS -gt 1 ]]; then
            log "Parallel workers: $PARALLEL_JOBS"
        fi
    else
        log "Mode: Dual interface (eth0 + nordlynx)"
        log "CSV files: ${CSV_FILE}_eth0.csv, ${CSV_FILE}_nordlynx.csv"
    fi
    
    # Ensure we're in the right directory
    cd "$SCRIPT_DIR"
    
    if [[ "$NO_PROXY" == "true" ]]; then
        # No-proxy mode
        log "Scanning with direct connection (no proxy)..."
        run_scan_no_proxy "direct"
    elif [[ -n "$INTERFACE" ]]; then
        # Single interface mode (with optional migration)
        if [[ $PARALLEL_JOBS -gt 1 ]]; then
            # Parallel execution
            log "Starting parallel scan ($PARALLEL_JOBS workers) with $INTERFACE interface..."
            run_parallel_scan "$INTERFACE" "$MIGRATE"
        else
            # Sequential execution  
            if [[ -n "$MIGRATE" ]]; then
                log "Scanning with $INTERFACE interface and migration to $MIGRATE..."
                run_scan "$INTERFACE" "$MIGRATE"
            else
                log "Scanning with $INTERFACE interface..."
                run_scan "$INTERFACE" ""
            fi
        fi
    else
        # Dual interface mode (legacy behavior)
        if [[ $PARALLEL_JOBS -gt 1 ]]; then
            log "Warning: Parallel mode not supported with dual interface mode. Using sequential."
        fi
        log "Phase 1: Scanning with ETH0 interface..."
        run_scan "eth0" ""
        
        log "Phase 2: Scanning with NORDLYNX interface..."
        run_scan "nordlynx" ""
    fi
    
    local completion_time=$(date +%s)
    local elapsed=$((completion_time - SCRIPT_START_TIME))
    
    log "All scans completed successfully!"
    log "Scanning completed in $(format_duration $elapsed)"
}

# Run the main function
main "$@"
