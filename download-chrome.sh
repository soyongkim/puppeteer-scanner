#!/bin/bash

# Manual Chrome Headless Shell Download Script
# Use this if the main install.sh script fails to download Chrome

set -e

echo " Manual Chrome Headless Shell Download"
echo "========================================"

CHROME_VERSION="140.0.7339.82"
CHROME_URL="https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/linux64/chrome-headless-shell-linux64.zip"
CHROME_DIR="./chromium"
CHROME_BINARY="$CHROME_DIR/chrome-headless-shell-linux64/chrome-headless-shell"

# Check if already exists
if [[ -f "$CHROME_BINARY" ]]; then
    echo " Chrome Headless Shell already exists at: $CHROME_BINARY"
    echo " Testing binary..."
    if "$CHROME_BINARY" --version > /dev/null 2>&1; then
        echo " Chrome Headless Shell is working correctly"
        VERSION=$("$CHROME_BINARY" --version)
        echo "   Version: $VERSION"
    else
        echo " Chrome binary exists but is not working"
        echo "   Try installing system dependencies:"
        echo "   sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxss1"
    fi
    exit 0
fi

echo " Downloading Chrome Headless Shell v$CHROME_VERSION..."

# Check for download tools
if ! command -v wget &> /dev/null && ! command -v curl &> /dev/null; then
    echo " Neither wget nor curl is available"
    echo "Please install one of them:"
    echo "  Ubuntu/Debian: sudo apt-get install wget"
    echo "  CentOS/RHEL: sudo yum install wget"
    exit 1
fi

# Check for unzip
if ! command -v unzip &> /dev/null; then
    echo " unzip is not available"
    echo "Please install it:"
    echo "  Ubuntu/Debian: sudo apt-get install unzip"
    echo "  CentOS/RHEL: sudo yum install unzip"
    exit 1
fi

# Create directory
mkdir -p "$CHROME_DIR"

# Download
echo " Downloading from: $CHROME_URL"
if command -v wget &> /dev/null; then
    wget -q --show-progress -O chrome-headless-shell-linux64.zip "$CHROME_URL"
else
    curl -L --progress-bar -o chrome-headless-shell-linux64.zip "$CHROME_URL"
fi

# Verify download
if [[ ! -f "chrome-headless-shell-linux64.zip" ]]; then
    echo " Download failed"
    exit 1
fi

# Get file size for verification
SIZE=$(stat -c%s chrome-headless-shell-linux64.zip)
echo " Downloaded ${SIZE} bytes"

# Extract
echo " Extracting Chrome Headless Shell..."
unzip -q chrome-headless-shell-linux64.zip -d "$CHROME_DIR"

# Make executable
chmod +x "$CHROME_BINARY"

# Clean up
rm chrome-headless-shell-linux64.zip

# Verify installation
if [[ -f "$CHROME_BINARY" ]]; then
    echo " Chrome Headless Shell installed successfully"
    echo " Testing binary..."
    
    if "$CHROME_BINARY" --version > /dev/null 2>&1; then
        echo " Chrome Headless Shell is working correctly"
        VERSION=$("$CHROME_BINARY" --version)
        echo "   Version: $VERSION"
        echo "   Location: $CHROME_BINARY"
    else
        echo " Chrome binary installed but may have dependency issues"
        echo "   Try installing system dependencies:"
        echo "   sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxss1 libgconf-2-4 libxrandr2 libasound2 libpangocairo-1.0-0 libatk1.0-0 libcairo-gobject2 libgtk-3-0 libgdk-pixbuf2.0-0"
    fi
else
    echo " Installation failed - binary not found"
    exit 1
fi

echo ""
echo " Chrome Headless Shell setup complete!"
echo "You can now run: node puppeteer-scanner.js --url=example.com"
