#!/bin/bash

# Simple Installation Script for Puppeteer Scanner
# This script provides alternative installation methods when the main install.sh fails

set -e

echo "Simple Puppeteer Scanner Installation"
echo "===================================="
echo ""

# Function to install Node.js via system package manager
install_nodejs_system() {
    echo "Installing Node.js via system package manager..."
    
    if command -v apt-get &> /dev/null; then
        # Ubuntu/Debian
        echo "Detected Ubuntu/Debian system"
        sudo apt-get update
        sudo apt-get install -y nodejs npm
    elif command -v dnf &> /dev/null; then
        # Fedora/RHEL 8+
        echo "Detected Fedora/RHEL system with dnf"
        sudo dnf install -y nodejs npm
    elif command -v yum &> /dev/null; then
        # CentOS/RHEL 7
        echo "Detected CentOS/RHEL system with yum"
        sudo yum install -y nodejs npm
    else
        echo "Unsupported package manager. Please install Node.js manually from:"
        echo "https://nodejs.org/"
        exit 1
    fi
}

# Check if Node.js is already installed
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo "Node.js is already installed: $NODE_VERSION"
else
    echo "Node.js not found. Installing..."
    install_nodejs_system
fi

# Verify installation
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "Failed to install Node.js. Please install manually from https://nodejs.org/"
    exit 1
fi

echo ""
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"
echo ""

# Install dependencies
echo "Installing dependencies..."
if ! npm install; then
    echo "Failed to install dependencies. Please check your internet connection and try again."
    exit 1
fi

echo ""
echo "Installation completed successfully!"
echo ""
echo "You can now run the scanner with:"
echo "  node puppeteer-client.js --url=example.com"
echo ""
echo "For help with available options:"
echo "  node puppeteer-client.js --help"