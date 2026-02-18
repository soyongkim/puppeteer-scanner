#!/bin/bash

# Kill Scanner - Emergency cleanup script for puppeteer scanners
# Usage: ./kill-puppeteer-parallel-scanner.sh
# This script forcefully stops all processes related to puppeteer scanners:
# - puppeteer-quic-parallel.sh (original scanner)
# - puppeteer-scan-dns.sh (DNS-aware scanner)

echo "🛑 Emergency cleanup: Stopping all puppeteer scanner processes..."

# Function to kill processes by pattern and show what was killed
kill_by_pattern() {
    local pattern="$1"
    local description="$2"
    
    local pids=$(pgrep -f "$pattern" 2>/dev/null)
    if [[ -n "$pids" ]]; then
        echo "🔴 Stopping $description..."
        pkill -f "$pattern"
        echo "   ✅ Killed PIDs: $pids"
    else
        echo "✅ No $description processes found"
    fi
}

# Function to force kill specific PIDs
force_kill_pids() {
    local pattern="$1"
    local description="$2"
    
    local pids=$(pgrep -f "$pattern" 2>/dev/null)
    if [[ -n "$pids" ]]; then
        echo "🔴 Force killing $description..."
        kill -9 $pids 2>/dev/null
        echo "   ✅ Force killed PIDs: $pids"
    fi
}

echo ""
echo "Step 1: Stopping main puppeteer scanner processes..."
kill_by_pattern "puppeteer-quic-parallel" "puppeteer parallel scanner scripts"
kill_by_pattern "puppeteer-scan-dns" "DNS-aware scanner scripts"

echo ""
echo "Step 2: Stopping QUIC proxy processes..."
kill_by_pattern "launch_proxy.sh" "QUIC proxy launch scripts"
kill_by_pattern "script_proxy.sh" "QUIC proxy scripts"
kill_by_pattern "target/release/quiche_server" "QUIC server processes"
kill_by_pattern "quic_server" "QUIC server processes (alt pattern)"

echo ""
echo "Step 3: Stopping Node.js test processes..."
kill_by_pattern "puppeteer-client.js" "Node.js puppeteer client processes"
kill_by_pattern "timeout.*puppeteer-client" "Node.js timeout processes"

echo ""
echo "Step 4: Stopping Chrome headless processes..."
kill_by_pattern "chrome-headless-shell" "Chrome headless processes"
kill_by_pattern "chrome-headless" "Chrome headless processes"

echo ""
echo "Step 5: Stopping any remaining timeout processes..."
kill_by_pattern "timeout.*node" "timeout wrapper processes"

echo ""
echo "Step 6: Force killing any stubborn processes..."
force_kill_pids "puppeteer-quic-parallel" "stubborn parallel scanner processes"
force_kill_pids "puppeteer-scan-dns" "stubborn DNS scanner processes"
force_kill_pids "puppeteer-client.js" "stubborn puppeteer processes"
force_kill_pids "target/release/quiche_server" "stubborn QUIC processes"
force_kill_pids "quic_server" "stubborn QUIC processes (alt pattern)"
force_kill_pids "chrome-headless" "stubborn Chrome processes"

echo ""
echo "Step 7: Final verification..."
remaining=$(ps aux | grep -E "(puppeteer|quiche_server|quic_server|chrome-headless|timeout.*node)" | grep -v grep | grep -v "kill-puppeteer-parallel-scanner.sh")
if [[ -n "$remaining" ]]; then
    echo "⚠️  Some processes may still be running:"
    echo "$remaining"
    echo ""
    echo "🔧 If processes persist, you can manually force kill them with:"
    echo "   kill -9 <PID>"
    echo ""
    echo "📋 To see process tree use:"
    echo "   ps aux --forest | grep -E '(puppeteer|chrome|node)'"
else
    echo "✅ All puppeteer scanner processes successfully stopped!"
fi

echo ""
echo "🧹 Cleanup completed!"
echo "💡 Supported scanners:"
echo "   • puppeteer-quic-parallel.sh (parallel scanner)"
echo "   • puppeteer-scan-dns.sh (DNS-aware scanner)"
echo ""
echo "💡 Tip: You can also add this to your .bashrc as an alias:"
echo "   alias killscanner='cd ~/Workspace/puppeteer-scanner && ./kill-puppeteer-parallel-scanner.sh'"