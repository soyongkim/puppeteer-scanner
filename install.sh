#!/bin/bash

# Puppeteer Scanner Installation Script
# This script installs all dependencies and sets up the environment

set -e  # Exit on any error

echo " Installing Puppeteer Scanner..."
echo "=================================="

# Function to install Node.js via nvm
install_nodejs_via_nvm() {
    echo " Installing Node.js via nvm..."
    
    # Download and install nvm
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.4/install.sh | bash
    
    # Source nvm
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Install latest LTS Node.js
    nvm install --lts
    nvm use --lts
    
    # Ensure nvm is available in new terminal sessions
    if ! grep -q "NVM_DIR" ~/.bashrc; then
        echo ""
        echo " Adding nvm to ~/.bashrc for future terminal sessions..."
        echo '' >> ~/.bashrc
        echo '# Load nvm (Node Version Manager)' >> ~/.bashrc
        echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
        echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm' >> ~/.bashrc
        echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion' >> ~/.bashrc
        echo " nvm added to ~/.bashrc"
    else
        echo " nvm already configured in ~/.bashrc"
    fi
    
    echo " Node.js installed via nvm"
}

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo " Node.js is not installed!"
    echo ""
    echo "We recommend installing Node.js via nvm (Node Version Manager)."
    echo "This allows you to easily manage multiple Node.js versions."
    echo ""
    read -p "Would you like to install Node.js via nvm? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        install_nodejs_via_nvm
    else
        echo "Please install Node.js manually:"
        echo "  - Via nvm: https://github.com/nvm-sh/nvm#installing-and-updating"
        echo "  - Direct download: https://nodejs.org/"
        echo "  - Package manager: sudo apt install nodejs npm (Ubuntu/Debian)"
        exit 1
    fi
fi

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2)
REQUIRED_VERSION="16.0.0"

# Simple version comparison (works for most cases)
compare_versions() {
    local current_version=$1
    local required_version=$2
    
    # Convert versions to comparable integers
    current_major=$(echo $current_version | cut -d'.' -f1)
    required_major=$(echo $required_version | cut -d'.' -f1)
    
    if [ "$current_major" -ge "$required_major" ]; then
        return 0
    else
        return 1
    fi
}

if ! compare_versions "$NODE_VERSION" "$REQUIRED_VERSION"; then
    echo " Node.js version $NODE_VERSION detected. Version 16.0.0 or higher is recommended."
    echo ""
    if command -v nvm &> /dev/null; then
        echo "You have nvm installed. You can upgrade Node.js with:"
        echo "  nvm install --lts"
        echo "  nvm use --lts"
    else
        echo "Consider using nvm to manage Node.js versions:"
        echo "  https://github.com/nvm-sh/nvm#installing-and-updating"
    fi
    echo ""
    read -p "Continue anyway? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo " npm is not available!"
    echo "npm should be installed with Node.js. Please reinstall Node.js."
    exit 1
fi

echo " Node.js $(node --version) detected"
echo " npm $(npm --version) detected"

# Install dependencies
echo ""
echo " Installing dependencies..."
npm install

# Install Chrome Headless Shell system dependencies
echo ""
echo " Installing Chrome Headless Shell system dependencies..."

# Function to install Chrome dependencies
install_chrome_dependencies() {
    if command -v apt-get &> /dev/null; then
        echo " Installing Chrome dependencies via apt-get..."
        sudo apt-get update -qq
        sudo apt-get install -y -qq \
            libnss3 \
            libatk-bridge2.0-0 \
            libdrm2 \
            libxss1 \
            libgconf-2-4 \
            libxrandr2 \
            libasound2 \
            libpangocairo-1.0-0 \
            libatk1.0-0 \
            libcairo-gobject2 \
            libgtk-3-0 \
            libgdk-pixbuf2.0-0 \
            libgbm1 \
            libxshmfence1
        echo " Chrome dependencies installed successfully"
    elif command -v yum &> /dev/null; then
        echo " Installing Chrome dependencies via yum..."
        sudo yum install -y -q \
            nss \
            atk \
            at-spi2-atk \
            libdrm \
            libxss \
            GConf2 \
            libXrandr \
            alsa-lib \
            pango \
            cairo-gobject \
            gtk3 \
            gdk-pixbuf2 \
            mesa-libgbm \
            libxshmfence
        echo " Chrome dependencies installed successfully"
    elif command -v dnf &> /dev/null; then
        echo " Installing Chrome dependencies via dnf..."
        sudo dnf install -y -q \
            nss \
            atk \
            at-spi2-atk \
            libdrm \
            libxss \
            GConf2 \
            libXrandr \
            alsa-lib \
            pango \
            cairo-gobject \
            gtk3 \
            gdk-pixbuf2 \
            mesa-libgbm \
            libxshmfence
        echo " Chrome dependencies installed successfully"
    else
        echo " Could not detect package manager. You may need to install Chrome dependencies manually:"
        echo "   Ubuntu/Debian: sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxss1 libgconf-2-4 libxrandr2 libasound2 libpangocairo-1.0-0 libatk1.0-0 libcairo-gobject2 libgtk-3-0 libgdk-pixbuf2.0-0 libgbm1 libxshmfence1"
        echo "   CentOS/RHEL: sudo yum install nss atk at-spi2-atk libdrm libxss GConf2 libXrandr alsa-lib pango cairo-gobject gtk3 gdk-pixbuf2 mesa-libgbm libxshmfence"
    fi
}

# Install Chrome dependencies
install_chrome_dependencies

# Download and setup Chrome Headless Shell
echo ""
echo " Setting up Chrome Headless Shell..."

CHROME_DIR="./chromium"
CHROME_BINARY="$CHROME_DIR/chrome-headless-shell-linux64/chrome-headless-shell"
CHROME_VERSION="140.0.7339.82"
CHROME_URL="https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/linux64/chrome-headless-shell-linux64.zip"

# Check if Chrome binary already exists
if [[ -f "$CHROME_BINARY" ]]; then
    echo " Chrome Headless Shell already installed at: $CHROME_BINARY"
else
    echo " Downloading Chrome Headless Shell v$CHROME_VERSION..."
    
    # Check if wget or curl is available
    if command -v wget &> /dev/null; then
        DOWNLOAD_CMD="wget -q --show-progress"
    elif command -v curl &> /dev/null; then
        DOWNLOAD_CMD="curl -L -o chrome-headless-shell-linux64.zip"
    else
        echo " Neither wget nor curl is available for downloading Chrome."
        echo "Please install wget or curl and try again."
        exit 1
    fi
    
    # Create chromium directory
    mkdir -p "$CHROME_DIR"
    
    # Download Chrome Headless Shell
    if command -v wget &> /dev/null; then
        wget -q --show-progress -O chrome-headless-shell-linux64.zip "$CHROME_URL"
    else
        curl -L -o chrome-headless-shell-linux64.zip "$CHROME_URL"
    fi
    
    # Check if download was successful
    if [[ ! -f "chrome-headless-shell-linux64.zip" ]]; then
        echo " Failed to download Chrome Headless Shell"
        exit 1
    fi
    
    # Check if unzip is available
    if ! command -v unzip &> /dev/null; then
        echo " unzip is not available. Please install unzip and try again."
        echo "Ubuntu/Debian: sudo apt-get install unzip"
        echo "CentOS/RHEL: sudo yum install unzip"
        rm -f chrome-headless-shell-linux64.zip
        exit 1
    fi
    
    # Extract Chrome Headless Shell
    echo " Extracting Chrome Headless Shell..."
    unzip -q chrome-headless-shell-linux64.zip -d "$CHROME_DIR"
    
    # Clean up zip file
    rm chrome-headless-shell-linux64.zip
    
    # Make Chrome binary executable
    chmod +x "$CHROME_BINARY"
    
    # Verify extraction was successful
    if [[ -f "$CHROME_BINARY" ]]; then
        echo " Chrome Headless Shell installed successfully at: $CHROME_BINARY"
        
        # Test the binary
        if "$CHROME_BINARY" --version > /dev/null 2>&1; then
            echo " Chrome Headless Shell is working correctly"
        else
            echo " Chrome Headless Shell binary may have issues (version check failed)"
            echo "   This might be due to missing system dependencies or an incompatible system."
            echo "   If issues persist, you may need to install additional dependencies manually:"
            echo "   Ubuntu/Debian: sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxss1 libgconf-2-4 libxrandr2 libasound2 libpangocairo-1.0-0 libatk1.0-0 libcairo-gobject2 libgtk-3-0 libgdk-pixbuf2.0-0 libgbm1 libxshmfence1"
            echo "   CentOS/RHEL: sudo yum install nss atk at-spi2-atk libdrm libxss GConf2 libXrandr alsa-lib pango cairo-gobject gtk3 gdk-pixbuf2 mesa-libgbm libxshmfence"
        fi
    else
        echo " Chrome Headless Shell extraction failed"
        exit 1
    fi
fi

echo ""
echo " Installation completed!"
echo ""
echo "Usage examples:"
echo "  node puppeteer-scanner.js --url=example.com"
echo "  node puppeteer-scanner.js --url=example.com --use-proxy=true --csv=batch_01.csv"
echo "  node puppeteer-scanner.js --url=example.com --use-proxy=true --tcp-fallback"
echo ""
echo "For more information, check the README.md file."
