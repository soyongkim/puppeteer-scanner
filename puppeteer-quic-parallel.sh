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
#    - Starts a fresh QUIC proxy server instance (script_proxy.sh + quiche_server)
#    - Runs client test (puppeteer_chromium_client.js) against the domain through proxy
#    - Collects comprehensive performance and migration statistics
#    - Kills both proxy and client processes completely
#    - Repeats for next domain with clean proxy/client session
# 3. Supports parallel execution with isolated proxy instances per worker
# 4. Aggregates results into CSV format
#
# Usage:
#   ./proxy_client_scanner.sh [options]
#
# Options:
#   --input=FILE         Input domain list (default: tranco_full_list.txt)
#   --output_dir=DIR     Output directory (default: bypassing_results_tic_test)
#   --start=N            Start from domain N (for resumption)
#   --max=N              Maximum domains to process
#   --parallel=N         Number of parallel scans (default: 1)
#   --interface=NAME     Network interface for proxy (e.g., eth0, nordlynx)
#   --migrate=NAME       Migration interface for proxy (e.g., nordlynx)
#   --num=N              Number of runs per domain (default: 1)
#   --num=mad_3          MAD analysis with 3 target runs (baseline + migration)
#   --num=mad_5          MAD analysis with 5 target runs (baseline + migration)
#   --no-proxy           Run without proxy (direct connection)
#   --pv-migration       Enable path validation migration in proxy
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
MAD_MODE=""
MAD_TARGET_RUNS=0
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
            NUM_ARG="${1#*=}"
            if [[ "$NUM_ARG" == "mad_3" || "$NUM_ARG" == "mad_5" ]]; then
                MAD_MODE="$NUM_ARG"
                if [[ "$NUM_ARG" == "mad_3" ]]; then
                    MAD_TARGET_RUNS=3
                else
                    MAD_TARGET_RUNS=5
                fi
                NUM_RUNS=1  # Will be dynamically adjusted in MAD mode
            else
                NUM_RUNS="$NUM_ARG"
            fi
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
            echo "Options:"
            echo "  --input=FILE         Input domain list (default: geo_blocking_list.txt)"
            echo "  --output_dir=DIR     Output directory (default: bypassing_results)"
            echo "  --start=N            Start from domain N (for resumption)"
            echo "  --max=N              Maximum domains to process"
            echo "  --parallel=N         Number of parallel scans (default: 1)"
            echo "  --timeout=N          Timeout per domain in seconds (default: 60)"
            echo "  --interface=NAME     Network interface for proxy (e.g., eth0, nordlynx)"
            echo "  --migrate=NAME       Migration interface for proxy (e.g., nordlynx)"
            echo "  --num=N              Number of runs per domain (default: 1)"
            echo "  --num=mad_3          MAD analysis with 3 target runs (MAD-only mode)"
            echo "  --num=mad_5          MAD analysis with 5 target runs (MAD-only mode)"
            echo "  --pair               Enable paired mode: baseline + migration phases"
            echo "  --no-proxy           Run without proxy (direct connection)"
            echo "  --pv-migration       Enable path validation migration in proxy"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Scan all domains (dual interface mode)"
            echo "  $0 --interface=eth0                   # Scan using only eth0 interface"
            echo "  $0 --interface=eth0 --migrate=nordlynx # Scan with eth0 and migration to nordlynx"
            echo "  $0 --start=100 --max=50              # Scan 50 domains starting from #100"
            echo "  $0 --parallel=3                      # Run 3 parallel scans"
            echo "  $0 --num=3                           # Run each domain 3 times for consistency"
            echo "  $0 --num=mad_5 --pair --interface=nordlynx --migrate=ens18 # MAD with baseline + migration"
            echo "  $0 --num=mad_5 --interface=nordlynx   # MAD-only mode (no migration)"
            echo "  $0 --no-proxy                        # Run without proxy (direct connection)"
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

# Validate --pair option
if [[ "$PAIR_MODE" == "true" ]]; then
    if [[ -z "$MIGRATE" ]]; then
        echo "Error: --pair requires migration interface (--migrate=INTERFACE)"
        exit 1
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
    
    # Calculate unique report port for this worker (base 9090 + worker_id * 10)
    local report_port=$((9090 + worker_id * 10))
    
    # Kill any existing proxy processes on this specific port
    pkill -f "quiche_server.*$port" 2>/dev/null || true
    pkill -f "script_proxy.*$port" 2>/dev/null || true
    # Also kill any processes on the report port
    if command -v lsof >/dev/null 2>&1; then
        local report_pids=$(lsof -ti:$report_port 2>/dev/null || true)
        if [[ -n "$report_pids" ]]; then
            kill -9 $report_pids 2>/dev/null || true
        fi
    fi
    sleep 0.5
    
    cd "$(dirname "$PROXY_SCRIPT")"
    
    # Build proxy command arguments with custom port and report port
    local proxy_args=("$interface")
    if [[ -n "$migrate_interface" ]]; then
        proxy_args+=("$migrate_interface")
    fi
    if [[ "$PV_MIGRATION" == "true" ]]; then
        proxy_args+=("--pv-migration")
    fi
    proxy_args+=("--port=$port")
    proxy_args+=("--report-port=$report_port")
    
    # Start proxy in background
    local proxy_log="$worker_output_dir/proxy_worker_${worker_id}.log"
    nohup "$PROXY_SCRIPT" "${proxy_args[@]}" > "$proxy_log" 2>&1 &
    local proxy_pid=$!
    
    # Wait for proxy to start on the custom port
    local attempts=0
    while [[ $attempts -lt 15 ]]; do
        if nc -z localhost "$port" 2>/dev/null; then
            return 0  # Success
        fi
        sleep 0.2
        attempts=$((attempts + 1))
    done
    
    return 1  # Failed to start
}

stop_proxy_worker() {
    local port="$1"
    local worker_id="$2"
    
    # Calculate the report port for this worker
    local report_port=$((9090 + worker_id * 10))
    
    # Kill processes specific to this port
    pkill -f "quiche_server.*$port" 2>/dev/null || true
    pkill -f "script_proxy.*$port" 2>/dev/null || true
    pkill -f "cargo run.*quiche_server.*$port" 2>/dev/null || true
    
    # Wait for processes to terminate, with adaptive checking
    local cleanup_attempts=0
    while [[ $cleanup_attempts -lt 10 ]]; do
        if ! pgrep -f "quiche_server.*$port" > /dev/null && ! pgrep -f "script_proxy.*$port" > /dev/null; then
            break  # Processes terminated successfully
        fi
        sleep 0.1
        cleanup_attempts=$((cleanup_attempts + 1))
    done
    
    # Force kill if still running after adaptive wait
    pkill -9 -f "quiche_server.*$port" 2>/dev/null || true
    pkill -9 -f "script_proxy.*$port" 2>/dev/null || true
    
    # Also kill by port using lsof if available
    if command -v lsof >/dev/null 2>&1; then
        # Kill QUIC proxy port
        local pids=$(lsof -ti:$port 2>/dev/null || true)
        if [[ -n "$pids" ]]; then
            kill -9 $pids 2>/dev/null || true
        fi
        
        # Kill dedicated report server port for this worker
        local report_pids=$(lsof -ti:$report_port 2>/dev/null || true)
        if [[ -n "$report_pids" ]]; then
            kill -9 $report_pids 2>/dev/null || true
        fi
    fi
    
    sleep 0.5
}

# Run parallel worker process
run_parallel_worker() {
    local worker_id="$1"
    local chunk_file="$2"
    local interface="$3"
    local migrate_interface="$4"
    local worker_port="$5"
    local worker_output_dir="$6"
    local mad_mode="$7"
    local mad_target_runs="$8"
    
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
    
    if [[ -n "$mad_mode" ]]; then
        worker_log "Processing $total_chunk_domains domains with MAD analysis ($mad_mode: $((mad_target_runs * 2)) total runs) (starting from index $resume_from)"
    else
        worker_log "Processing $total_chunk_domains domains with $NUM_RUNS runs each (starting from index $resume_from)"
    fi
    
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
        
        # Test domain based on mode (MAD analysis or regular runs)
        local domain_success=false
        if [[ "$PAIR_MODE" == "true" && -n "$migrate_interface" ]]; then
            # Paired mode: baseline + migration phases
            if [[ -n "$mad_mode" ]]; then
                # MAD Paired mode
                worker_log "MAD paired mode: $mad_mode (target runs: $mad_target_runs per phase)"
                if test_domain_mad "$domain" "$global_index" "$interface" "$migrate_interface" "$mad_target_runs" "$worker_id" "$worker_port"; then
                    domain_success=true
                    worker_log "[$current/${#domains[@]}] MAD paired analysis completed: $domain"
                else
                    worker_log "[$current/${#domains[@]}] MAD paired analysis failed: $domain"
                fi
            else
                # Regular Paired mode
                worker_log "Paired mode: $NUM_RUNS runs per phase"
                if test_domain_paired "$domain" "$global_index" "$interface" "$migrate_interface" "$NUM_RUNS" "$worker_id" "$worker_port"; then
                    domain_success=true
                    worker_log "[$current/${#domains[@]}] Paired analysis completed: $domain"
                else
                    worker_log "[$current/${#domains[@]}] Paired analysis failed: $domain"
                fi
            fi
        elif [[ -n "$mad_mode" ]]; then
            # MAD-only mode: single interface with MAD filtering
            worker_log "MAD-only mode: $mad_mode (target runs: $mad_target_runs with filtering)"
            if test_domain_mad_only "$domain" "$global_index" "$interface" "$mad_target_runs" "$worker_id" "$worker_port"; then
                domain_success=true
                worker_log "[$current/${#domains[@]}] MAD-only analysis completed: $domain"
            else
                worker_log "[$current/${#domains[@]}] MAD-only analysis failed: $domain"
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
                
                # Wait for proxy to be ready
                sleep 1
                
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
                sleep 1  # Brief pause between runs
            done
        fi
        
        if [[ $domain_success == true ]]; then
            success_count=$((success_count + 1))
            if [[ -n "$mad_mode" ]]; then
                worker_log "MAD analysis completed: $domain"
            else
                worker_log "Domain completed: $domain"
            fi
        else
            failed_count=$((failed_count + 1))
            if [[ -n "$mad_mode" ]]; then
                worker_log "MAD analysis failed: $domain"
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
        run_parallel_worker "$worker_id" "$chunk_file" "$interface" "$migrate_interface" "$worker_port" "$worker_output_dir" "$MAD_MODE" "$MAD_TARGET_RUNS" &
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
    
    # If MAD mode, use MAD-specific aggregation, otherwise use regular aggregation
    if [[ -n "$MAD_MODE" ]] || [[ "$NUM_RUNS" == "mad_3" ]] || [[ "$NUM_RUNS" == "mad_5" ]]; then
        log "Running MAD mode merge (MAD_MODE='$MAD_MODE', NUM_RUNS='$NUM_RUNS')"
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
    
    # Kill any existing proxy processes (including Rust processes)
    pkill -f "script_proxy.sh" 2>/dev/null || true
    pkill -f "quiche_server" 2>/dev/null || true
    pkill -f "cargo run" 2>/dev/null || true
    sleep 0.3
    
    # Start proxy in background with specified interface and optional migration
    cd "$(dirname "$PROXY_SCRIPT")"
    
    # Build proxy command arguments
    local proxy_args=("$interface")
    if [[ -n "$migrate_interface" ]]; then
        proxy_args+=("$migrate_interface")
    fi
    if [[ "$PV_MIGRATION" == "true" ]]; then
        proxy_args+=("--pv-migration")
    fi
    
    if [[ -n "$migrate_interface" ]]; then
        nohup "$PROXY_SCRIPT" "${proxy_args[@]}" > "$TIMESTAMPED_OUTPUT_DIR/proxy_${interface}_migrate_${migrate_interface}.log" 2>&1 &
    else
        nohup "$PROXY_SCRIPT" "${proxy_args[@]}" > "$TIMESTAMPED_OUTPUT_DIR/proxy_${interface}.log" 2>&1 &
    fi
    PROXY_PID=$!
    
    # Wait for Rust process with adaptive checking + minimum QUIC stabilization
    local rust_startup_attempts=0
    local rust_ready=false
    
    while [[ $rust_startup_attempts -lt 20 ]]; do
        if pgrep -f "quiche_server" > /dev/null && nc -z localhost 4433 2>/dev/null; then
            rust_ready=true
            break
        fi
        sleep 0.2
        rust_startup_attempts=$((rust_startup_attempts + 1))
    done
    
    # Minimum stabilization time for QUIC server
    if [[ $rust_ready == true ]]; then
        # Allow QUIC server to fully initialize internal state
        sleep 0.8
    else
        # If startup detection failed, wait longer
        sleep 1.5
    fi
    
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
    
    # Kill all proxy-related processes
    pkill -f "script_proxy.sh" 2>/dev/null || true
    pkill -f "quiche_server" 2>/dev/null || true 
    pkill -f "cargo run.*quiche_server" 2>/dev/null || true
    
    # Force kill if still running
    sleep 0.3
    pkill -9 -f "quiche_server" 2>/dev/null || true
    pkill -9 -f "cargo run.*quiche_server" 2>/dev/null || true
    pkill -9 -f "script_proxy.sh" 2>/dev/null || true
    
    # Kill processes on known ports
    if command -v lsof >/dev/null 2>&1; then
        # Kill web server port (9090)
        local web_pids=$(lsof -ti:9090 2>/dev/null || true)
        if [[ -n "$web_pids" ]]; then
            log "Killing web server processes on port 9090"
            kill -9 $web_pids 2>/dev/null || true
        fi
        
        # Kill main proxy port (4433)
        local proxy_pids=$(lsof -ti:4433 2>/dev/null || true)
        if [[ -n "$proxy_pids" ]]; then
            log "Killing proxy processes on port 4433"
            kill -9 $proxy_pids 2>/dev/null || true
        fi
    fi
    
    # Verify cleanup with adaptive checking
    local cleanup_verify_attempts=0
    while [[ $cleanup_verify_attempts -lt 10 ]]; do
        if ! pgrep -f "quiche_server" > /dev/null; then
            log "Proxy stopped"
            return 0
        fi
        sleep 0.1
        cleanup_verify_attempts=$((cleanup_verify_attempts + 1))
    done
    
    # If still running after adaptive wait
    if pgrep -f "quiche_server" > /dev/null; then
        error_log "Warning: Some proxy processes may still be running"
        # Final aggressive cleanup
        pkill -9 -f "quiche_server" 2>/dev/null || true
    else
        log "Proxy stopped"
    fi
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

# ── MAD Analysis Functions ──────────────────────────────────────────────────────────────────────────────────

# Calculate median of an array
calculate_median() {
    local values=("$@")
    local count=${#values[@]}
    
    if [[ $count -eq 0 ]]; then
        echo "0"
        return
    fi
    
    # Filter out invalid values
    local valid_values=()
    for value in "${values[@]}"; do
        if [[ "$value" != "-" && "$value" =~ ^[0-9]+\.?[0-9]*$ ]]; then
            valid_values+=("$value")
        fi
    done
    
    count=${#valid_values[@]}
    if [[ $count -eq 0 ]]; then
        echo "0"
        return
    fi
    
    # Sort values numerically
    IFS=$'\n' sorted=($(sort -n <<<"${valid_values[*]}")); unset IFS
    
    if [[ $((count % 2)) -eq 1 ]]; then
        # Odd number of elements
        local middle=$((count / 2))
        echo "${sorted[$middle]}"
    else
        # Even number of elements - return average of two middle values
        local mid1=$((count / 2 - 1))
        local mid2=$((count / 2))
        echo "scale=2; (${sorted[$mid1]} + ${sorted[$mid2]}) / 2" | bc -l
    fi
}

# Calculate mean of an array
calculate_mean() {
    local values=("$@")
    local count=${#values[@]}
    
    if [[ $count -eq 0 ]]; then
        echo "0"
        return
    fi
    
    # Filter out invalid values
    local valid_values=()
    for value in "${values[@]}"; do
        if [[ "$value" != "-" && "$value" =~ ^[0-9]+\.?[0-9]*$ ]]; then
            valid_values+=("$value")
        fi
    done
    
    count=${#valid_values[@]}
    if [[ $count -eq 0 ]]; then
        echo "0"
        return
    fi
    
    local sum=0
    for value in "${valid_values[@]}"; do
        sum=$(echo "scale=2; $sum + $value" | bc -l)
    done
    
    echo "scale=2; $sum / $count" | bc -l
}

# Enhanced Two-Stage Outlier Detection
calculate_mad_outliers() {
    local values=("$@")
    local count=${#values[@]}
    
    if [[ $count -lt 3 ]]; then
        # Return all indices as valid (no outliers) if less than 3 values
        for ((i=0; i<count; i++)); do
            echo -n "$i "
        done
        echo
        return
    fi
    
    # Filter out invalid values and keep track of original indices
    local valid_values=()
    local valid_indices_map=()
    for ((i=0; i<count; i++)); do
        local value="${values[$i]}"
        if [[ "$value" != "-" && "$value" =~ ^[0-9]+\.?[0-9]*$ ]]; then
            valid_values+=("$value")
            valid_indices_map+=("$i")
        fi
    done
    
    local valid_count=${#valid_values[@]}
    if [[ $valid_count -lt 3 ]]; then
        # Return all original indices if we don't have enough valid values for MAD analysis
        for ((i=0; i<count; i++)); do
            echo -n "$i "
        done
        echo
        return
    fi
    
    # Initial filter: Remove extremely small values relative to the dataset
    # Find the maximum value to establish a baseline
    local max_value=0
    for value in "${valid_values[@]}"; do
        local is_larger=$(echo "$value > $max_value" | bc -l)
        if [[ "$is_larger" == "1" ]]; then
            max_value=$value
        fi
    done
    
    # Filter out values that are less than 1% of the maximum value
    local min_threshold=$(echo "scale=2; $max_value * 0.01" | bc -l)
    local filtered_values=()
    local filtered_indices=()
    
    for ((i=0; i<valid_count; i++)); do
        local value="${valid_values[$i]}"
        local is_not_tiny=$(echo "$value >= $min_threshold" | bc -l)
        
        if [[ "$is_not_tiny" == "1" ]]; then
            filtered_values+=("$value")
            filtered_indices+=("${valid_indices_map[$i]}")
        fi
    done
    
    local filtered_count=${#filtered_values[@]}
    
    # If initial filter removed too many values, use all valid values
    if [[ $filtered_count -lt 2 ]]; then
        filtered_values=("${valid_values[@]}")
        filtered_indices=("${valid_indices_map[@]}")
        filtered_count=$valid_count
    fi
    
    # Calculate median and MAD from filtered data
    local median=$(calculate_median "${filtered_values[@]}")
    
    local deviations=()
    for value in "${filtered_values[@]}"; do
        local deviation=$(echo "scale=2; if ($value > $median) $value - $median else $median - $value" | bc -l)
        deviations+=("$deviation")
    done
    
    local mad=$(calculate_median "${deviations[@]}")
    local scaled_mad=$(echo "scale=4; $mad * 1.4826" | bc -l)
    local threshold=$(echo "scale=4; $scaled_mad * 3" | bc -l)
    
    # Add minimum threshold to handle cases where MAD is very small (like uniform data)
    local min_threshold=$(echo "scale=2; $median * 0.05" | bc -l)  # 5% of median
    local final_threshold=$(echo "scale=4; if ($threshold > $min_threshold) $threshold else $min_threshold" | bc -l)
    
    # Apply MAD filtering
    local final_valid_indices=()
    for ((i=0; i<filtered_count; i++)); do
        local value="${filtered_values[$i]}"
        local deviation=$(echo "scale=2; if ($value > $median) $value - $median else $median - $value" | bc -l)
        local is_valid=$(echo "$deviation <= $final_threshold" | bc -l)
        
        if [[ "$is_valid" == "1" ]]; then
            final_valid_indices+=("${filtered_indices[$i]}")
        fi
    done
    
    # Ensure we have at least 2 valid results
    if [[ ${#final_valid_indices[@]} -lt 2 ]]; then
        # Fallback: return all filtered indices if MAD filtering is too strict
        echo "${filtered_indices[@]}"
    else
        echo "${final_valid_indices[@]}"
    fi
}

# Parse CSV data from a single run and extract required fields
parse_csv_run_data() {
    local csv_file="$1"
    local domain="$2"
    
    # Check if file exists and has data
    if [[ ! -f "$csv_file" ]] || [[ $(wc -l < "$csv_file") -lt 2 ]]; then
        echo "NO_DATA"
        return 1
    fi
    
    # Find the last line for this domain (most recent run)
    # Handle both formats: with timestamp (^timestamp,$domain,) and without timestamp (^$domain,)
    local last_line=$(grep ",$domain," "$csv_file" | tail -1)
    if [[ -z "$last_line" ]]; then
        # Fallback to original format without timestamp
        last_line=$(grep "^$domain," "$csv_file" | tail -1)
    fi
    
    if [[ -z "$last_line" ]]; then
        echo "NO_DATA"
        return 1
    fi
    
    # Parse CSV fields (adjust indices based on actual CSV structure)
    IFS=',' read -ra fields <<< "$last_line"
    
    # Detect if first field is timestamp (contains 'T' and 'Z')
    local field_offset=0
    if [[ "${fields[0]}" =~ T.*Z ]]; then
        field_offset=1  # Skip timestamp column
    fi
    
    local sni="${fields[$((field_offset + 0))]}"
    local ip_addr="${fields[$((field_offset + 1))]}" 
    local status_code="${fields[$((field_offset + 2))]}"      # first_status_code column
    local load_time="${fields[$((field_offset + 9))]}"        # load_time column
    local total_data="${fields[$((field_offset + 24))]}"      # total_data_amount column
    local migrated_data="${fields[$((field_offset + 25))]}"   # total_migrated_data_amount column
    local migrated_domains="${fields[$((field_offset + 35))]}" # migrated_domains column
    
    # Validate critical fields
    if [[ "$status_code" == "-" || "$status_code" == "FAILED" || "$status_code" == "failed to lookup address" || -z "$status_code" ]]; then
        echo "NO_200"
        return 1
    fi
    
    # Accept 200 OK, 301/302 redirects, and "undefined" (which means successful redirect)
    local redirected_status="${fields[$((field_offset + 5))]}"  # redirected_status_code column
    if [[ "$status_code" == "200" ]]; then
        # Direct 200 response is valid
        true
    elif [[ "$status_code" == "301" || "$status_code" == "302" ]]; then
        # Redirect codes need successful final status
        if [[ "$redirected_status" != "200" && "$redirected_status" != "-" ]]; then
            echo "NO_200"  
            return 1
        fi
    elif [[ "$status_code" == "undefined" ]]; then
        # "undefined" status typically means successful redirect without initial status
        # Check if there's a redirected domain (meaning redirect happened successfully)
        local redirected_domain="${fields[$((field_offset + 3))]}"
        if [[ "$redirected_domain" == "-" || -z "$redirected_domain" ]]; then
            echo "NO_200"  
            return 1
        fi
    else
        # All other status codes are considered failures
        echo "NO_200"
        return 1
    fi
    
    # Validate numeric fields
    if [[ "$load_time" == "-" || -z "$load_time" ]]; then
        echo "INVALID_LOAD_TIME"
        return 1
    fi
    
    # For total_data, treat "-" as 0 for valid connections (redirects might not have data metrics)
    if [[ "$total_data" == "-" || -z "$total_data" ]]; then
        total_data="0"
    fi
    
    # For migrated_data, treat "-" as 0 (expected for baseline or non-migrating connections)
    if [[ "$migrated_data" == "-" || -z "$migrated_data" ]]; then
        migrated_data="0"
    fi
    
    # Handle phase-specific data
    if [[ "$3" == "baseline" ]]; then
        # For baseline phase, ignore migration data (should be 0)
        migrated_data="0"
        migrated_domains="-"
    elif [[ "$3" == "migration" ]]; then
        # For migration phase, accept all valid scans including zero migration
        # Zero migration indicates the domain doesn't support migration but scan succeeded
        if [[ -z "$migrated_data" ]]; then
            migrated_data="0"
        fi
    fi
    
    # Return parsed data using tab delimiter to avoid conflicts with colons in migrated_domains
    echo -e "SUCCESS\t$sni\t$ip_addr\t$status_code\t$load_time\t$total_data\t$migrated_data\t$migrated_domains"
    return 0
}

# Process migrated domains to calculate averages (matching Python logic)
process_migrated_domains() {
    local migrated_domains_array=("$@")
    
    if [ ${#migrated_domains_array[@]} -eq 0 ]; then
        echo "~"
        return
    fi
    
    # Create temporary file for processing
    local temp_data="/tmp/migrated_domains_$$"
    > "$temp_data"
    
    # Parse all migrated domains entries
    for entry in "${migrated_domains_array[@]}"; do
        if [ -n "$entry" ] && [ "$entry" != "-" ]; then
            # Split by semicolon to get individual domain entries
            echo "$entry" | tr ';' '\n' | while read -r domain_entry; do
                domain_entry=$(echo "$domain_entry" | xargs) # trim whitespace
                if [ -n "$domain_entry" ]; then
                    # Parse format: domain:ip(total_bytes:migrated_bytes)
                    if [[ "$domain_entry" =~ ^([^:]+):([^(]+)\(([^:]+):([^)]+)\)$ ]]; then
                        subdomain="${BASH_REMATCH[1]}"
                        ip="${BASH_REMATCH[2]}"
                        total_bytes="${BASH_REMATCH[3]}"
                        migrated_bytes="${BASH_REMATCH[4]}"
                        
                        # Only include entries with valid numeric data
                        if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [[ "$migrated_bytes" =~ ^[0-9]+$ ]]; then
                            # Only include non-zero entries
                            if [ "$total_bytes" -gt 0 ] || [ "$migrated_bytes" -gt 0 ]; then
                                echo "$subdomain|$ip|$total_bytes|$migrated_bytes" >> "$temp_data"
                            fi
                        fi
                    fi
                fi
            done
        fi
    done
    
    # Calculate averages per subdomain
    local all_domains_formatted=""
    local dominant_subdomain=""
    local max_avg_bytes=0
    
    # Get unique subdomains
    if [ -f "$temp_data" ] && [ -s "$temp_data" ]; then
        for subdomain in $(cut -d'|' -f1 "$temp_data" | sort -u); do
            # Get all entries for this subdomain
            local subdomain_data=$(grep "^$subdomain|" "$temp_data")
            
            if [ -n "$subdomain_data" ]; then
                local total_sum=0
                local migrated_sum=0
                local count=0
                local most_common_ip=""
                
                # Calculate sums and find most common IP
                local temp_ips="/tmp/ips_$$"
                > "$temp_ips"
                
                while IFS='|' read -r sub ip total mig; do
                    total_sum=$((total_sum + total))
                    migrated_sum=$((migrated_sum + mig))
                    count=$((count + 1))
                    echo "$ip" >> "$temp_ips"
                done <<< "$subdomain_data"
                
                # Find most common IP
                if [ -f "$temp_ips" ] && [ -s "$temp_ips" ]; then
                    most_common_ip=$(sort "$temp_ips" | uniq -c | sort -nr | head -1 | awk '{print $2}')
                fi
                
                # Calculate averages
                local avg_total=$((total_sum / count))
                local avg_migrated=$((migrated_sum / count))
                
                # Format: subdomain:ip(avg_total:avg_migrated):count
                local formatted_domain="$subdomain:$most_common_ip($avg_total:$avg_migrated):$count"
                
                if [ -n "$all_domains_formatted" ]; then
                    all_domains_formatted="$all_domains_formatted; $formatted_domain"
                else
                    all_domains_formatted="$formatted_domain"
                fi
                
                # Check if this is the dominant domain (highest average total bytes)
                if [ "$avg_total" -gt "$max_avg_bytes" ]; then
                    max_avg_bytes=$avg_total
                    dominant_subdomain="$subdomain:$most_common_ip"
                fi
                
                rm -f "$temp_ips"
            fi
        done
    fi
    
    # Clean up
    rm -f "$temp_data"
    
    # Return results with delimiter
    echo "${all_domains_formatted}~${dominant_subdomain}"
}

# Paired mode: Run baseline + migration phases with regular run counts (non-MAD)
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
        else
            stop_proxy
        fi
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
        else
            stop_proxy
        fi
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

# MAD-only mode: Run MAD filtering on single interface until target runs achieved
test_domain_mad_only() {
    local domain="$1"
    local index="$2"
    local interface="$3"
    local target_runs="$4"
    local worker_id="${5:-""}"
    local worker_port="${6:-""}"
    
    log "[$index] Starting MAD-only analysis for: $domain (target: $target_runs runs)"
    
    # Create CSV file for MAD-only mode
    local worker_suffix=""
    if [[ -n "$worker_id" ]]; then
        worker_suffix="_worker_${worker_id}"
    fi
    
    local worker_dir="${TIMESTAMPED_OUTPUT_DIR}/parallel_workers"
    mkdir -p "$worker_dir"
    
    local mad_csv="${worker_dir}/mad_only_run_${interface}${worker_suffix}.csv"
    
    # Run MAD analysis on single interface
    local results=()
    local load_times=()
    local data_amounts=()
    local attempts=0
    local max_attempts=$((target_runs * 2))
    local consecutive_failures=0
    local max_consecutive_failures=$target_runs
    
    while [[ ${#results[@]} -lt $target_runs && $attempts -lt $max_attempts && $consecutive_failures -lt $max_consecutive_failures ]]; do
        attempts=$((attempts + 1))
        log "  [$index] MAD-only run $attempts for $domain"
        
        # Start proxy for this run
        if [[ -n "$worker_port" ]]; then
            if ! start_proxy_worker "$interface" "" "$worker_port" "$worker_id" "$(dirname "$mad_csv")"; then
                error_log "Failed to start worker proxy for MAD-only run $attempts of $domain (port $worker_port)"
                continue
            fi
        else
            if ! start_proxy "$interface" ""; then
                error_log "Failed to start proxy for MAD-only run $attempts of $domain"
                continue
            fi
        fi
        
        # Run test
        cd "$CLIENT_SCRIPT_DIR"
        local run_success=false
        if [[ -n "$worker_port" ]]; then
            local report_port=$((9090 + worker_id * 10))
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$mad_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                run_success=true
            fi
        else
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$mad_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                run_success=true
            fi
        fi
        
        if [[ "$run_success" == "true" ]]; then
            local parse_result=$(parse_csv_run_data "$mad_csv" "$domain" "mad_only")
            if [[ "$parse_result" == SUCCESS* ]]; then
                IFS='	' read -ra data <<< "$parse_result"
                local load_time="${data[4]}"
                local total_data="${data[5]}"
                
                results+=("$parse_result")
                load_times+=("$load_time")
                data_amounts+=("$total_data")
                consecutive_failures=0
                
                log "  [$index] MAD-only run $attempts successful: load_time=$load_time, data=$total_data"
            else
                consecutive_failures=$((consecutive_failures + 1))
                log "  [$index] MAD-only run $attempts failed: $parse_result (consecutive failures: $consecutive_failures)"
            fi
        else
            consecutive_failures=$((consecutive_failures + 1))
            log "  [$index] MAD-only run $attempts timed out or failed (consecutive failures: $consecutive_failures)"
        fi
        
        # Stop proxy
        if [[ -n "$worker_port" ]]; then
            stop_proxy_worker "$worker_port" "$worker_id"
        else
            stop_proxy
        fi
    done
    
    # Check results and apply MAD filtering
    if [[ ${#results[@]} -eq 0 ]]; then
        log "[$index] No successful MAD-only runs for $domain"
        return 1
    fi
    
    if [[ ${#results[@]} -lt $target_runs ]]; then
        log "[$index] Insufficient MAD-only runs for $domain: ${#results[@]}/$target_runs"
        return 1
    fi
    
    # Apply MAD filtering
    log "[$index] Applying MAD filtering to $domain data amounts..."
    local valid_indices=$(calculate_mad_outliers "${data_amounts[@]}")
    local valid_results=()
    local valid_load_times=()
    local valid_data_amounts=()
    
    for idx in $valid_indices; do
        valid_results+=("${results[$idx]}")
        valid_load_times+=("${load_times[$idx]}")
        valid_data_amounts+=("${data_amounts[$idx]}")
    done
    
    if [[ ${#valid_results[@]} -lt $target_runs ]]; then
        log "[$index] MAD filtering resulted in insufficient valid runs: ${#valid_results[@]}/$target_runs"
        return 1
    fi
    
    # Limit to exactly target_runs
    if [[ ${#valid_results[@]} -gt $target_runs ]]; then
        valid_load_times=("${valid_load_times[@]:0:$target_runs}")
        valid_data_amounts=("${valid_data_amounts[@]:0:$target_runs}")
    fi
    
    # Calculate statistics
    local median_load=$(calculate_median "${valid_load_times[@]}")
    local median_data=$(calculate_median "${valid_data_amounts[@]}")
    
    log "[$index] MAD-only analysis completed for $domain: med_load=$median_load, med_data=$median_data"
    return 0
}

# MAD-based domain testing with baseline and migration phases (PAIR MODE)
# QUICK SCAN MODE: Optimized for speed - calculates medians only, skips averages and unstable tracking
test_domain_mad() {
    local domain="$1"
    local index="$2"
    local interface="$3"
    local migrate_interface="$4"
    local target_runs="$5"
    local worker_id="${6:-""}"
    local worker_port="${7:-""}"
    
    log "[$index] Starting MAD analysis for: $domain (target: $target_runs runs per phase)"
    
    # Create phase-specific CSV files
    local worker_suffix=""
    if [[ -n "$worker_id" ]]; then
        worker_suffix="_worker_${worker_id}"
    fi
    
    # MAD mode uses consolidated worker files (placed in parallel_workers directory)
    local worker_dir="${TIMESTAMPED_OUTPUT_DIR}/parallel_workers"
    mkdir -p "$worker_dir"
    
    local baseline_csv="${worker_dir}/baseline_run_${interface}${worker_suffix}.csv"
    local migration_csv="${worker_dir}/migration_run_${interface}_to_${migrate_interface}${worker_suffix}.csv"
    # QUICK SCAN: DISABLED averages worker files only
    # local avg_results_csv="${worker_dir}/${TIMESTAMP}_averages${worker_suffix}.csv"
    local unstable_csv="${worker_dir}/${TIMESTAMP}_unstable_domains${worker_suffix}.csv"
    
    # QUICK SCAN: Skip averages CSV creation
    # if [[ ! -f "$avg_results_csv" ]]; then
    #     echo "SNI,ip_addr,main_first_status,median_load_time_only,median_total_data_amount_only,median_load_time_migrated,median_total_data_amount_migrated" > "$avg_results_csv"
    # fi
    
    # QUICK SCAN: Disabled unstable domains tracking for speed
    # if [[ ! -f "$unstable_csv" ]]; then
    #     echo "SNI,phase,reason,attempted_runs" > "$unstable_csv"
    # fi
    
    # Initialize consolidated worker CSV files with headers (they will accumulate all runs)
    # We'll get the header from the first successful run and then append all subsequent runs    # ── Phase 1: Baseline (no migration) ──
    log "[$index] Phase 1: Baseline analysis for $domain"
    
    # Temporarily disable migration for baseline
    local original_migrate="$migrate_interface"
    local original_pv_migration="$PV_MIGRATION"
    migrate_interface=""
    PV_MIGRATION=false
    
    local baseline_results=()
    local baseline_load_times=()
    local baseline_data_amounts=()
    local baseline_ips=()
    local attempts=0
    # Set max attempts: MAD_3=6, MAD_5=8
    local max_attempts
    if [[ $target_runs -eq 3 ]]; then
        max_attempts=6
    elif [[ $target_runs -eq 5 ]]; then
        max_attempts=8
    else
        max_attempts=$((target_runs * 2))  # Fallback for other values
    fi
    local consecutive_failures=0
    local max_consecutive_failures=$target_runs  # Stop after target_runs consecutive failures (MAD_3=3, MAD_5=5)
    local non_200_count=0  # Track all non-200 responses
    
    while [[ ${#baseline_results[@]} -lt $target_runs && $attempts -lt $max_attempts && $consecutive_failures -lt $max_consecutive_failures ]]; do
        attempts=$((attempts + 1))
        log "  [$index] Baseline run $attempts for $domain"
        
        # Start fresh proxy for each run
        if [[ -n "$worker_port" ]]; then
            # Use worker-specific proxy with custom port
            if ! start_proxy_worker "$interface" "" "$worker_port" "$worker_id" "$(dirname "$baseline_csv")"; then
                error_log "Failed to start worker proxy for baseline run $attempts of $domain (port $worker_port)"
                continue
            fi
        else
            # Use regular proxy (for sequential mode)
            if ! start_proxy "$interface" ""; then
                error_log "Failed to start proxy for baseline run $attempts of $domain"
                continue
            fi
        fi
        
        # Run test and append to consolidated baseline CSV file
        cd "$CLIENT_SCRIPT_DIR"
        if [[ -n "$worker_port" ]]; then
            # Use worker-specific proxy port and report port
            local report_port=$((9090 + worker_id * 10))
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$baseline_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                baseline_run_success=true
            else
                baseline_run_success=false
            fi
        else
            # Use default proxy settings
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$baseline_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                baseline_run_success=true
            else
                baseline_run_success=false
            fi
        fi
        
        if [[ "$baseline_run_success" == "true" ]]; then
            # Parse results from the consolidated baseline file
            local parse_result=$(parse_csv_run_data "$baseline_csv" "$domain" "baseline")
            if [[ "$parse_result" == SUCCESS* ]]; then
                IFS='	' read -ra data <<< "$parse_result"
                local sni="${data[1]}"
                local ip_addr="${data[2]}"
                local load_time="${data[4]}"
                local total_data="${data[5]}"
                
                baseline_results+=("$parse_result")
                baseline_load_times+=("$load_time")
                baseline_data_amounts+=("$total_data")
                baseline_ips+=("$ip_addr")
                consecutive_failures=0  # Reset consecutive failure counter on success
                
                log "  [$index] Baseline run $attempts successful: load_time=$load_time, data=$total_data"
            else
                consecutive_failures=$((consecutive_failures + 1))
                log "  [$index] Baseline run $attempts failed: $parse_result (consecutive failures: $consecutive_failures)"
                
                # Track all non-200 responses (redirects, errors, etc.)
                if [[ "$parse_result" == "NO_200" ]]; then
                    non_200_count=$((non_200_count + 1))
                    log "  [$index] Non-200 response detected ($non_200_count so far)"
                    
                    # If we've seen target_runs non-200 responses, stop early
                    if [[ $non_200_count -ge $target_runs ]]; then
                        log "[$index] Domain $domain consistently returns non-200 responses ($non_200_count non-200 responses) - treating as failure"
                        # echo "$domain,baseline,consecutive_failures_3,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
                        
                        # Restore migration settings before returning
                        migrate_interface="$original_migrate"
                        PV_MIGRATION="$original_pv_migration"
                        return 1
                    fi
                fi
                
                # Check for specific connection failure patterns for early termination
                if [[ "$parse_result" == *"connection refused"* ]]; then
                    log "  [$index] Connection-level failure detected for $domain"
                fi
            fi
        else
            consecutive_failures=$((consecutive_failures + 1))
            log "  [$index] Baseline run $attempts timed out or failed (consecutive failures: $consecutive_failures)"
        fi
        
        if [[ -n "$worker_port" ]]; then
            stop_proxy_worker "$worker_port" "$worker_id"
        else
            stop_proxy
        fi
    done
    
    # Check if we stopped due to consecutive failures
    if [[ $consecutive_failures -ge $max_consecutive_failures ]]; then
        log "[$index] Too many consecutive failures ($consecutive_failures) for $domain - domain appears unreachable"
        # echo "$domain,baseline,consecutive_failures_${consecutive_failures},$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        return 1
    fi
    
    # Check if we have enough baseline runs
    if [[ ${#baseline_results[@]} -eq 0 ]]; then
        log "[$index] No successful baseline runs for $domain - skipping migration analysis (all connection failures or errors)"
        # echo "$domain,baseline,no_200_responses,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        return 1
    fi
    
    if [[ ${#baseline_results[@]} -lt $target_runs ]]; then
        log "[$index] Insufficient baseline runs for $domain: ${#baseline_results[@]}/$target_runs"
        # echo "$domain,baseline,insufficient_runs_${#baseline_results[@]}_of_$target_runs,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        return 1
    fi
    
    # Enhanced validation: Check for meaningful HTTP responses (non-zero data and valid load times)
    local meaningful_runs=0
    for i in "${!baseline_results[@]}"; do
        local result="${baseline_results[$i]}"
        local load_time="${baseline_load_times[$i]}"
        local data_amount="${baseline_data_amounts[$i]}"
        
        # Check if this is a meaningful result (has load time, data, and not just connection errors)
        if [[ "$load_time" != "-" && "$load_time" != "" && $(echo "$data_amount > 0" | bc -l 2>/dev/null || echo 0) -eq 1 ]]; then
            # Additional check: ensure it's not just connection refused or error states
            if [[ "$result" != *"connection refused"* && "$result" != *"net::ERR_"* && "$load_time" =~ ^[0-9]+\.?[0-9]*$ ]]; then
                meaningful_runs=$((meaningful_runs + 1))
            fi
        fi
    done
    
    if [[ $meaningful_runs -eq 0 ]]; then
        log "[$index] No meaningful HTTP responses for $domain (all connection failures or errors)"
        # echo "$domain,baseline,no_meaningful_responses,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        return 1
    fi
    
    if [[ $meaningful_runs -lt 2 ]]; then
        log "[$index] Only $meaningful_runs meaningful responses for $domain - insufficient for migration analysis"
        # echo "$domain,baseline,insufficient_meaningful_responses_${meaningful_runs},$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        return 1
    fi
    
    # Apply MAD filtering to baseline data amounts
    log "[$index] Applying MAD filtering to baseline data amounts..."
    local valid_indices=$(calculate_mad_outliers "${baseline_data_amounts[@]}")
    local valid_baseline_results=()
    local valid_baseline_load_times=()
    local valid_baseline_data_amounts=()
    
    for idx in $valid_indices; do
        valid_baseline_results+=("${baseline_results[$idx]}")
        valid_baseline_load_times+=("${baseline_load_times[$idx]}")
        valid_baseline_data_amounts+=("${baseline_data_amounts[$idx]}")
    done
    
    # If we don't have enough valid runs after MAD filtering, collect more
    while [[ ${#valid_baseline_results[@]} -lt $target_runs && $attempts -lt $max_attempts ]]; do
        attempts=$((attempts + 1))
        log "  [$index] Additional baseline run $attempts (MAD filtering) for $domain"
        
        if [[ -n "$worker_port" ]]; then
            if ! start_proxy_worker "$interface" "" "$worker_port" "$worker_id" "$(dirname "$LOG_FILE")"; then
                error_log "Failed to start proxy worker for additional baseline run $attempts of $domain"
                continue
            fi
        else
            if ! start_proxy "$interface" ""; then
                error_log "Failed to start proxy for additional baseline run $attempts of $domain"
                continue
            fi
        fi
        
        # Run additional baseline test and append to consolidated baseline CSV
        cd "$CLIENT_SCRIPT_DIR"
        if [[ -n "$worker_port" ]]; then
            # Use worker-specific proxy port and report port
            local report_port=$((9090 + worker_id * 10))
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$baseline_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                additional_baseline_success=true
            else
                additional_baseline_success=false
            fi
        else
            # Use default proxy settings
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$baseline_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                additional_baseline_success=true
            else
                additional_baseline_success=false
            fi
        fi
        
        if [[ "$additional_baseline_success" == "true" ]]; then
            local parse_result=$(parse_csv_run_data "$baseline_csv" "$domain" "baseline")
            if [[ "$parse_result" == SUCCESS* ]]; then
                IFS='	' read -ra data <<< "$parse_result"
                local load_time="${data[4]}"
                local total_data="${data[5]}"
                
                # Add to all results and recalculate MAD
                baseline_results+=("$parse_result")
                baseline_load_times+=("$load_time")
                baseline_data_amounts+=("$total_data")
                baseline_ips+=("${data[2]}")
                
                # Recalculate valid indices
                valid_indices=$(calculate_mad_outliers "${baseline_data_amounts[@]}")
                valid_baseline_results=()
                valid_baseline_load_times=()
                valid_baseline_data_amounts=()
                
                for idx in $valid_indices; do
                    valid_baseline_results+=("${baseline_results[$idx]}")
                    valid_baseline_load_times+=("${baseline_load_times[$idx]}")
                    valid_baseline_data_amounts+=("${baseline_data_amounts[$idx]}")
                done
                
                log "  [$index] Additional baseline run successful: valid=${#valid_baseline_results[@]}/$target_runs"
            fi
        fi
        
        if [[ -n "$worker_port" ]]; then
            stop_proxy_worker "$worker_port" "$worker_id"
        else
            stop_proxy
        fi
    done
    
    if [[ ${#valid_baseline_results[@]} -lt $target_runs ]]; then
        log "[$index] Cannot collect $target_runs valid baseline runs for $domain after $attempts attempts"
        # echo "$domain,baseline,mad_filtering_failed_${#valid_baseline_results[@]}_valid_of_$target_runs,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        return 1
    fi
    
    # Use the already MAD-filtered baseline data (no additional filtering needed)
    local final_baseline_load_times=("${valid_baseline_load_times[@]}")
    local final_baseline_data_amounts=("${valid_baseline_data_amounts[@]}")
    
    # Ensure we never use more than target_runs results (limit to exactly 3 for MAD_3)
    if [[ ${#final_baseline_load_times[@]} -gt $target_runs ]]; then
        log "[$index] Limiting baseline results to target_runs ($target_runs): ${#final_baseline_load_times[@]} -> $target_runs"
        # Keep only the first target_runs results to ensure consistency
        final_baseline_load_times=("${final_baseline_load_times[@]:0:$target_runs}")
        final_baseline_data_amounts=("${final_baseline_data_amounts[@]:0:$target_runs}")
    fi
    
    # Calculate baseline statistics (QUICK SCAN: using only medians)
    local baseline_median_load=$(calculate_median "${final_baseline_load_times[@]}")
    # local baseline_avg_load=$(calculate_mean "${final_baseline_load_times[@]}")  # DISABLED for quick scan
    local baseline_median_data=$(calculate_median "${final_baseline_data_amounts[@]}")
    # local baseline_avg_data=$(calculate_mean "${final_baseline_data_amounts[@]}")  # DISABLED for quick scan
    
    # Get unique IPs
    local unique_ips=$(printf "%s\n" "${baseline_ips[@]}" | sort -u | tr '\n' ';' | sed 's/;$//')
    
    log "[$index] Baseline stats for $domain: med_load=$baseline_median_load, med_data=$baseline_median_data (QUICK SCAN: averages disabled)"
    
    # ── Phase 2: Enhanced Migration Analysis with Conditional Strategy ──
    log "[$index] Phase 2: Enhanced migration analysis for $domain (conditional strategy)"
    
    # Restore migration settings
    migrate_interface="$original_migrate"
    PV_MIGRATION="$original_pv_migration"
    
    local migration_results=()
    local migration_load_times=()
    local migration_data_amounts=()
    local migration_migrated_domains=()
    local migration_has_data=false
    attempts=0
    
    # Stage 1: Initial migration capability detection
    log "  [$index] Stage 1: Testing migration capability for $domain"
    
    while [[ ${#migration_results[@]} -lt $target_runs && $attempts -lt $max_attempts ]]; do
        attempts=$((attempts + 1))
        log "    [$index] Initial migration run $attempts for $domain"
        
        # Start fresh proxy with migration
        if [[ -n "$worker_port" ]]; then
            if ! start_proxy_worker "$interface" "$migrate_interface" "$worker_port" "$worker_id" "$(dirname "$LOG_FILE")"; then
                error_log "Failed to start proxy worker for migration run $attempts of $domain"
                continue
            fi
        else
            if ! start_proxy "$interface" "$migrate_interface"; then
                error_log "Failed to start proxy for migration run $attempts of $domain"
                continue
            fi
        fi
        
        # Run test and append to consolidated migration CSV file
        cd "$CLIENT_SCRIPT_DIR"
        if [[ -n "$worker_port" ]]; then
            # Use worker-specific proxy port and report port
            local report_port=$((9090 + worker_id * 10))
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                migration_success=true
            else
                migration_success=false
            fi
        else
            # Use default proxy settings
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                migration_success=true
            else
                migration_success=false
            fi
        fi
        
        if [[ "$migration_success" == "true" ]]; then
            local parse_result=$(parse_csv_run_data "$migration_csv" "$domain" "migration")
            if [[ "$parse_result" == SUCCESS* ]]; then
                IFS='	' read -ra data <<< "$parse_result"
                local load_time="${data[4]}"
                local total_data="${data[5]}"
                local migrated_domains="${data[7]}"
                
                # Extract migrated data amount from CSV (handle timestamp column)
                local csv_line=$(grep ",$domain," "$migration_csv" | tail -1)
                if [[ -z "$csv_line" ]]; then
                    csv_line=$(tail -n 1 "$migration_csv" | grep "^$domain,")
                fi
                
                # Detect timestamp column and adjust field number
                local field_num=25  # Default: total_migrated_data_amount is column 25 (0-indexed: 24)
                if [[ "$csv_line" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z, ]]; then
                    field_num=26  # With timestamp: shift by 1
                fi
                local migrated_data_amount=$(echo "$csv_line" | cut -d',' -f"$field_num")
                
                # Accept all successful runs initially
                migration_results+=("$parse_result")
                migration_load_times+=("$load_time")
                migration_data_amounts+=("$total_data")
                migration_migrated_domains+=("$migrated_domains")
                
                # Check if this run has actual migration data
                if [[ -n "$migrated_data_amount" && $(echo "$migrated_data_amount > 0" | bc -l) == "1" ]]; then
                    migration_has_data=true
                    log "    [$index] Migration run $attempts with actual data: ${migrated_data_amount} bytes migrated"
                else
                    log "    [$index] Migration run $attempts with no migration: ${migrated_data_amount:-0} bytes"
                fi
            else
                log "    [$index] Migration run $attempts failed: $parse_result"
            fi
        else
            log "    [$index] Migration run $attempts timed out or failed"
        fi
        
        if [[ -n "$worker_port" ]]; then
            stop_proxy_worker "$worker_port" "$worker_id"
        else
            stop_proxy
        fi
    done
    
    # Stage 2: Check migration capability and decide strategy
    if [[ ${#migration_results[@]} -eq 0 ]]; then
        log "[$index] No successful migration runs for $domain"
        # echo "$domain,migration,no_valid_migration_responses,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        # QUICK SCAN: Averages CSV output DISABLED for speed
        # echo "$domain,$unique_ips,200,$baseline_median_load,$baseline_median_data,-,-" >> /dev/null
        return 0
    fi
    
    if [[ "$migration_has_data" == "false" ]]; then
        # No migration capability detected - handle non-migration case
        log "[$index] Domain $domain doesn't support migration: all ${#migration_results[@]} runs had migrated_data=0"
        # echo "$domain,migration,no_migration_support_all_runs_zero_migration,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
        
        # Still calculate stats from non-migrated runs (they're valid performance data)
        local final_migration_load_times=("${migration_load_times[@]}")
        local final_migration_data_amounts=("${migration_data_amounts[@]}")
        local final_migration_migrated_domains=("${migration_migrated_domains[@]}")
        
        # Limit to target_runs if we collected more
        if [[ ${#final_migration_load_times[@]} -gt $target_runs ]]; then
            final_migration_load_times=("${final_migration_load_times[@]:0:$target_runs}")
            final_migration_data_amounts=("${final_migration_data_amounts[@]:0:$target_runs}")
            final_migration_migrated_domains=("${final_migration_migrated_domains[@]:0:$target_runs}")
        fi
        
        # Calculate stats and save (QUICK SCAN: using only medians)
        local migration_median_load=$(calculate_median "${final_migration_load_times[@]}")
        # local migration_avg_load=$(calculate_mean "${final_migration_load_times[@]}")  # DISABLED for quick scan
        local migration_median_data=$(calculate_median "${final_migration_data_amounts[@]}")
        # local migration_avg_data=$(calculate_mean "${final_migration_data_amounts[@]}")  # DISABLED for quick scan
        
        # QUICK SCAN: Averages CSV output DISABLED for speed
        # echo "$domain,$unique_ips,200,$baseline_median_load,$baseline_median_data,$migration_median_load,$migration_median_data" >> /dev/null
        log "[$index] Saved no-migration results for $domain"
        return 0
    fi
    
    # Stage 3: Migration capability detected - collect full target_runs with MAD filtering
    log "  [$index] Stage 2: Migration capability detected - collecting $target_runs quality runs"
    
    # Continue collecting if we don't have enough runs yet
    while [[ ${#migration_results[@]} -lt $target_runs && $attempts -lt $max_attempts ]]; do
        attempts=$((attempts + 1))
        log "    [$index] Additional migration run $attempts for $domain"
        
        if [[ -n "$worker_port" ]]; then
            if ! start_proxy_worker "$interface" "$migrate_interface" "$worker_port" "$worker_id" "$(dirname "$LOG_FILE")"; then
                error_log "Failed to start proxy worker for additional migration run $attempts of $domain"
                continue
            fi
        else
            if ! start_proxy "$interface" "$migrate_interface"; then
                error_log "Failed to start proxy for additional migration run $attempts of $domain"
                continue
            fi
        fi
        
        cd "$CLIENT_SCRIPT_DIR"
        if [[ -n "$worker_port" ]]; then
            local report_port=$((9090 + worker_id * 10))
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                migration_success=true
            else
                migration_success=false
            fi
        else
            if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                migration_success=true
            else
                migration_success=false
            fi
        fi
        
        if [[ "$migration_success" == "true" ]]; then
            local parse_result=$(parse_csv_run_data "$migration_csv" "$domain" "migration")
            if [[ "$parse_result" == SUCCESS* ]]; then
                IFS='	' read -ra data <<< "$parse_result"
                local load_time="${data[4]}"
                local total_data="${data[5]}"
                local migrated_domains="${data[7]}"
                
                migration_results+=("$parse_result")
                migration_load_times+=("$load_time")
                migration_data_amounts+=("$total_data")
                migration_migrated_domains+=("$migrated_domains")
                
                log "    [$index] Additional migration run $attempts successful"
            fi
        fi
        
        if [[ -n "$worker_port" ]]; then
            stop_proxy_worker "$worker_port" "$worker_id"
        else
            stop_proxy
        fi
    done
    
    if [[ ${#migration_results[@]} -lt $target_runs ]]; then
        log "[$index] Insufficient migration runs for $domain: ${#migration_results[@]}/$target_runs"
        # echo "$domain,migration,insufficient_runs_${#migration_results[@]}_of_$target_runs,$attempts" >> "$unstable_csv"  # DISABLED for quick scan
    fi
    
    # Stage 4: Apply MAD filtering ONLY to runs with migrated_data > 0
    log "  [$index] Stage 3: Applying MAD filtering to migration-capable runs only"
    
    # Separate runs into migration-capable and non-capable
    local migration_capable_indices=()
    local migration_capable_data=()
    local all_migration_data=()
    
    for ((i=0; i<${#migration_results[@]}; i++)); do
        # Extract migrated data amount for this run from the original CSV line
        local run_domain=$(echo "${migration_results[$i]}" | cut -d$'\t' -f2)  # Use SNI field from parsed result
        local csv_lines=$(grep ",$run_domain," "$migration_csv")
        if [[ -z "$csv_lines" ]]; then
            csv_lines=$(grep "^$run_domain," "$migration_csv")
        fi
        local line_number=$((i + 1))
        local csv_line=$(echo "$csv_lines" | sed -n "${line_number}p")
        
        # Detect timestamp column and adjust field number
        local field_num=25  # Default: total_migrated_data_amount is column 25 (0-indexed: 24)
        if [[ "$csv_line" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z, ]]; then
            field_num=26  # With timestamp: shift by 1
        fi
        local migrated_data_amount=$(echo "$csv_line" | cut -d',' -f"$field_num")
        
        all_migration_data+=("${migrated_data_amount:-0}")
        
        if [[ -n "$migrated_data_amount" && $(echo "$migrated_data_amount > 0" | bc -l) == "1" ]]; then
            migration_capable_indices+=("$i")
            migration_capable_data+=("${migration_data_amounts[$i]}")
        fi
    done
    
    log "    Found ${#migration_capable_indices[@]} migration-capable runs out of ${#migration_results[@]} total"
    
    if [[ ${#migration_capable_indices[@]} -lt 2 ]]; then
        # Not enough migration-capable runs for MAD analysis - use all available runs
        log "    Not enough migration-capable runs for MAD analysis (${#migration_capable_indices[@]} < 2)"
        local final_indices=()
        for ((i=0; i<${#migration_results[@]}; i++)); do
            final_indices+=("$i")
        done
    else
        # Apply MAD filtering to migration-capable runs only
        local mad_valid_relative=$(calculate_mad_outliers "${migration_capable_data[@]}")
        local mad_valid_absolute=()
        
        for relative_idx in $mad_valid_relative; do
            local absolute_idx="${migration_capable_indices[$relative_idx]}"
            mad_valid_absolute+=("$absolute_idx")
        done
        
        log "    MAD filtering: ${#mad_valid_absolute[@]} valid runs from ${#migration_capable_indices[@]} migration-capable runs"
        
        # If MAD filtered out too many migration-capable runs, collect more
        local needed_runs=$((target_runs - ${#mad_valid_absolute[@]}))
        if [[ $needed_runs -gt 0 && $attempts -lt $max_attempts ]]; then
            log "    Need $needed_runs more migration-capable runs (MAD filtering removed outliers)"
            
            while [[ $needed_runs -gt 0 && $attempts -lt $max_attempts ]]; do
                attempts=$((attempts + 1))
                log "      [$index] Replacement migration run $attempts for $domain"
                
                if [[ -n "$worker_port" ]]; then
                    if ! start_proxy_worker "$interface" "$migrate_interface" "$worker_port" "$worker_id" "$(dirname "$LOG_FILE")"; then
                        continue
                    fi
                else
                    if ! start_proxy "$interface" "$migrate_interface"; then
                        continue
                    fi
                fi
                
                cd "$CLIENT_SCRIPT_DIR"
                if [[ -n "$worker_port" ]]; then
                    local report_port=$((9090 + worker_id * 10))
                    if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --proxy-port="$worker_port" --report-port="$report_port" --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                        replacement_success=true
                    else
                        replacement_success=false
                    fi
                else
                    if timeout "$TIMEOUT" node "$CLIENT_SCRIPT" --use-proxy --csv="$migration_csv" --url="$domain" >> "$LOG_FILE" 2>&1; then
                        replacement_success=true
                    else
                        replacement_success=false
                    fi
                fi
                
                if [[ "$replacement_success" == "true" ]]; then
                    local parse_result=$(parse_csv_run_data "$migration_csv" "$domain" "migration")
                    if [[ "$parse_result" == SUCCESS* ]]; then
                        # Check if this replacement run has migration data
                        local csv_line=$(grep ",$domain," "$migration_csv" | tail -1)
                        if [[ -z "$csv_line" ]]; then
                            csv_line=$(tail -n 1 "$migration_csv" | grep "^$domain,")
                        fi
                        
                        # Detect timestamp column and adjust field number
                        local field_num=25  # Default: total_migrated_data_amount is column 25 (0-indexed: 24)
                        if [[ "$csv_line" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z, ]]; then
                            field_num=26  # With timestamp: shift by 1
                        fi
                        local migrated_data_amount=$(echo "$csv_line" | cut -d',' -f"$field_num")
                        
                        if [[ -n "$migrated_data_amount" && $(echo "$migrated_data_amount > 0" | bc -l) == "1" ]]; then
                            # This replacement run has migration data - accept it
                            IFS='	' read -ra data <<< "$parse_result"
                            local load_time="${data[4]}"
                            local total_data="${data[5]}"
                            local migrated_domains="${data[7]}"
                            
                            migration_results+=("$parse_result")
                            migration_load_times+=("$load_time")
                            migration_data_amounts+=("$total_data")
                            migration_migrated_domains+=("$migrated_domains")
                            
                            # Add to valid indices
                            local new_index=$((${#migration_results[@]} - 1))
                            mad_valid_absolute+=("$new_index")
                            
                            needed_runs=$((needed_runs - 1))
                            log "      Replacement run accepted (has migration data: ${migrated_data_amount} bytes)"
                        else
                            log "      Replacement run rejected (no migration data: ${migrated_data_amount:-0} bytes)"
                        fi
                    fi
                fi
                
                if [[ -n "$worker_port" ]]; then
                    stop_proxy_worker "$worker_port" "$worker_id"
                else
                    stop_proxy
                fi
            done
        fi
        
        local final_indices=("${mad_valid_absolute[@]}")
    fi
    
    # Stage 5: Use filtered results to calculate final statistics
    local final_migration_load_times=()
    local final_migration_data_amounts=()
    local final_migration_migrated_domains=()
    
    for idx in "${final_indices[@]}"; do
        final_migration_load_times+=("${migration_load_times[$idx]}")
        final_migration_data_amounts+=("${migration_data_amounts[$idx]}")
        final_migration_migrated_domains+=("${migration_migrated_domains[$idx]}")
    done
    
    # Limit to target_runs
    if [[ ${#final_migration_load_times[@]} -gt $target_runs ]]; then
        log "[$index] Limiting migration results to target_runs ($target_runs): ${#final_migration_load_times[@]} -> $target_runs"
        final_migration_load_times=("${final_migration_load_times[@]:0:$target_runs}")
        final_migration_data_amounts=("${final_migration_data_amounts[@]:0:$target_runs}")
        final_migration_migrated_domains=("${final_migration_migrated_domains[@]:0:$target_runs}")
    fi
    
    # Calculate migration statistics (QUICK SCAN: using only medians)
    local migration_median_load=$(calculate_median "${final_migration_load_times[@]}")
    # local migration_avg_load=$(calculate_mean "${final_migration_load_times[@]}")  # DISABLED for quick scan
    local migration_median_data=$(calculate_median "${final_migration_data_amounts[@]}")
    # local migration_avg_data=$(calculate_mean "${final_migration_data_amounts[@]}")  # DISABLED for quick scan
    
    # QUICK SCAN: Skip complex domain processing for speed
    # local processed_domains_result=$(process_migrated_domains "${final_migration_migrated_domains[@]}")
    # IFS='~' read -ra domain_parts <<< "$processed_domains_result"
    # local all_migrated_domains="${domain_parts[0]:-}"
    # local dominant_domain="${domain_parts[1]:-}"
    
    log "[$index] Enhanced migration stats for $domain: med_load=$migration_median_load, med_data=$migration_median_data"
    
    # QUICK SCAN: Averages CSV output DISABLED for speed
    # echo "$domain,$unique_ips,200,$baseline_median_load,$baseline_median_data,$migration_median_load,$migration_median_data" >> /dev/null
    
    log "[$index] MAD analysis completed for $domain"
    log "[$index] Worker files created:"
    log "   - Baseline: $baseline_csv"
    log "   - Migration: $migration_csv"
    log "   - Averages: DISABLED for quick scan" 
    return 0
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
    
    # QUICK SCAN: Skip final averages file creation (disabled)
    # echo "SNI,ip_addr,main_first_status,median_load_time_only,median_total_data_amount_only,median_load_time_migrated,median_total_data_amount_migrated" > "$final_averages"
    # echo "SNI,phase,reason,attempted_runs" > "$final_unstable"  # DISABLED for quick scan
    
    # Look for worker files in the parallel_workers directory
    local worker_dir="${output_dir}/parallel_workers"
    
    # QUICK SCAN: Skip worker average files merging (disabled)
    local merged_count=0
    # for worker_avg in "$worker_dir"/*_averages_worker_*.csv; do
    #     if [[ -f "$worker_avg" ]]; then
    #         tail -n +2 "$worker_avg" >> "$final_averages"
    #         merged_count=$((merged_count + 1))
    #         log "  Merged averages from: $(basename "$worker_avg")"
    #     fi
    # done
    
    # QUICK SCAN: Skip unstable domains merging for speed
    # local unstable_count=0
    # for worker_unstable in "$worker_dir"/*_unstable_domains_worker_*.csv; do
    #     if [[ -f "$worker_unstable" ]]; then
    #         tail -n +2 "$worker_unstable" >> "$final_unstable"
    #         unstable_count=$((unstable_count + 1))
    #         log "  Merged unstable domains from: $(basename "$worker_unstable")"
    #     fi
    # done
    local unstable_count=0  # Set to 0 since we're skipping this
    
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
    
    log "Final merge results (QUICK SCAN MODE):"
    log "  - Averages worker files: DISABLED for speed (no *_averages_worker_*.csv generated)"  
    log "  - Unstable domain tracking: DISABLED for speed"
    log "  - Baseline phase files merged: $baseline_merged workers → $baseline_final"
    log "  - Migration phase files merged: $migration_merged workers → $migration_final"
    log "  - Individual baseline/migration CSV files: ENABLED"
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
            sleep 1
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
    sleep 1
    
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
        
        # Small delay between runs (except for the last one)
        if [[ $run_number -lt $NUM_RUNS ]]; then
            sleep 1  # Delay to ensure proxy fully stops
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
    sleep 1
    
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
        
        if [[ "$PAIR_MODE" == "true" && -n "$migrate_interface" ]]; then
            # Paired mode: baseline + migration phases
            if [[ -n "$MAD_MODE" ]]; then
                # MAD Paired mode
                if test_domain_mad "$domain" "$global_index" "$interface" "$migrate_interface" "$MAD_TARGET_RUNS"; then
                    log "[$global_index] MAD paired analysis completed: $domain (using $interface -> $migrate_interface migration)"
                else
                    error_log "MAD paired analysis failed: $domain (using $interface -> $migrate_interface migration)"
                fi
            else
                # Regular Paired mode
                if test_domain_paired "$domain" "$global_index" "$interface" "$migrate_interface" "$NUM_RUNS"; then
                    log "[$global_index] Paired analysis completed: $domain (using $interface -> $migrate_interface migration)"
                else
                    error_log "Paired analysis failed: $domain (using $interface -> $migrate_interface migration)"
                fi
            fi
        elif [[ -n "$MAD_MODE" ]]; then
            # MAD-only mode: single interface with MAD filtering
            if test_domain_mad_only "$domain" "$global_index" "$interface" "$MAD_TARGET_RUNS"; then
                log "[$global_index] MAD-only analysis completed: $domain (using $interface)"
            else
                error_log "MAD-only analysis failed: $domain (using $interface)"
            fi
        else
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
    
    # Stop any worker proxies with more aggressive cleanup
    log "Stopping all proxy processes..."
    pkill -f "quiche_server" 2>/dev/null || true
    pkill -f "script_proxy" 2>/dev/null || true
    pkill -f "cargo run.*quiche_server" 2>/dev/null || true
    
    # Force kill any remaining processes
    sleep 1
    pkill -9 -f "quiche_server" 2>/dev/null || true
    pkill -9 -f "script_proxy" 2>/dev/null || true
    pkill -9 -f "cargo run.*quiche_server" 2>/dev/null || true
    
    # Kill processes bound to port 9090 (web server)
    if command -v lsof >/dev/null 2>&1; then
        local pids_9090=$(lsof -ti:9090 2>/dev/null || true)
        if [[ -n "$pids_9090" ]]; then
            log "Killing processes on port 9090: $pids_9090"
            kill -9 $pids_9090 2>/dev/null || true
        fi
    fi
    
    # Kill processes bound to proxy ports (4433 and custom worker ports)
    for port in 4433 4500 4600 4700 4501 5002 4764; do
        if command -v lsof >/dev/null 2>&1; then
            local pids=$(lsof -ti:$port 2>/dev/null || true)
            if [[ -n "$pids" ]]; then
                log "Killing processes on port $port: $pids"
                kill -9 $pids 2>/dev/null || true
            fi
        fi
    done
    
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
        if [[ "$PAIR_MODE" == "true" && -n "$MIGRATE" ]]; then
            if [[ -n "$MAD_MODE" ]]; then
                log "Mode: MAD Paired Analysis ($INTERFACE -> $MIGRATE, $MAD_TARGET_RUNS runs per phase)"
            else
                log "Mode: Paired Analysis ($INTERFACE -> $MIGRATE, $NUM_RUNS runs per phase)"
            fi
            log "CSV file: ${CSV_FILE}_${INTERFACE}_migrate_${MIGRATE}.csv"
        elif [[ -n "$MAD_MODE" && "$PAIR_MODE" == "false" ]]; then
            log "Mode: MAD-only Analysis ($INTERFACE, $MAD_TARGET_RUNS runs with filtering)"
            log "CSV file: ${CSV_FILE}_${INTERFACE}.csv"
        elif [[ -n "$MIGRATE" ]]; then
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
            if [[ "$PAIR_MODE" == "true" && -n "$MIGRATE" ]]; then
                # Paired Mode: Baseline + Migration phases (works with any --num)
                if [[ -n "$MAD_MODE" ]]; then
                    log "Scanning with $INTERFACE interface and migration to $MIGRATE (MAD paired mode)..."
                else
                    log "Scanning with $INTERFACE interface and migration to $MIGRATE (paired mode)..."
                fi
                run_scan "$INTERFACE" "$MIGRATE"
            elif [[ -n "$MAD_MODE" && "$PAIR_MODE" == "false" ]]; then
                # MAD-only Mode: Just MAD filtering on single interface
                log "Scanning with $INTERFACE interface (MAD-only mode)..."
                run_scan "$INTERFACE" ""
            elif [[ -n "$MIGRATE" ]]; then
                # Regular migration mode
                log "Scanning with $INTERFACE interface and migration to $MIGRATE..."
                run_scan "$INTERFACE" "$MIGRATE"
            else
                # Single interface mode
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
