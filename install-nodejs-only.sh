#!/bin/bash

# Simple Node.js installation script that works with Snap curl
# Run this without sudo first, then run the main install.sh with sudo

echo "Installing Node.js via package manager..."
echo "========================================"

# Update package list
sudo apt update

# Install Node.js and npm via package manager (this avoids nvm issues with Snap curl)
sudo apt install -y nodejs npm

# Check Node.js version
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    NPM_VERSION=$(npm --version)
    echo "✅ Node.js $NODE_VERSION installed successfully"
    echo "✅ npm $NPM_VERSION installed successfully"
    
    # Check if version is sufficient (Node 16+ recommended)
    NODE_MAJOR=$(echo $NODE_VERSION | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_MAJOR" -ge 16 ]; then
        echo "✅ Node.js version is sufficient (v16+ required)"
    else
        echo "⚠️  Node.js version is older than recommended (v16+)"
        echo "   You may want to upgrade to a newer version"
    fi
else
    echo "❌ Node.js installation failed"
    exit 1
fi

echo ""
echo "Node.js installation completed!"
echo "Now you can run: sudo ./install.sh"
echo "It will skip the Node.js installation and proceed with dependencies."