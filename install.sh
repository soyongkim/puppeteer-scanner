#!/bin/bash

# Puppeteer Scanner Installation Script
# This script installs all dependencies and sets up the environment

set -e  # Exit on any error

echo " Installing Puppeteer Scanner..."
echo "=================================="

# Function to install Node.js via nvm
install_nodejs_via_nvm() {
    echo " Installing Node.js via nvm..."
    
    # Check if we're running as root, which can cause issues with nvm
    if [ "$EUID" -eq 0 ]; then
        echo " Warning: Running as root. nvm installation will be for root user."
        echo " You may want to run this script as a regular user instead."
        echo ""
    fi
    
    # Check if wget is available, install if needed
    if ! command -v wget &> /dev/null; then
        echo " Installing wget..."
        if command -v apt-get &> /dev/null; then
            apt-get update && apt-get install -y wget
        elif command -v yum &> /dev/null; then
            yum install -y wget
        else
            echo " Please install wget manually and run this script again."
            exit 1
        fi
    fi
    
    # Download nvm installation script using wget
    echo " Downloading nvm installation script..."
    TMP_FILE=$(mktemp)
    
    if wget -q -O "$TMP_FILE" https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh; then
        echo " Running nvm installation..."
        bash "$TMP_FILE"
        rm -f "$TMP_FILE"
    else
        echo " Failed to download nvm installation script."
        echo " Please install Node.js manually from https://nodejs.org/"
        rm -f "$TMP_FILE"
        exit 1
    fi
    
    # Source nvm for current session
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Verify nvm installation
    if ! command -v nvm &> /dev/null; then
        echo " nvm installation failed. Please install Node.js manually."
        echo " Visit: https://nodejs.org/ or https://github.com/nvm-sh/nvm"
        exit 1
    fi
    
    # Install latest LTS Node.js (v20+ required for Puppeteer)
    echo " Installing latest LTS Node.js..."
    nvm install --lts
    nvm use --lts
    nvm alias default lts/*
    
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
    
    # Verify Node.js installation
    if command -v node &> /dev/null; then
        echo " Node.js $(node --version) installed successfully via nvm"
        echo " npm $(npm --version) is available"
        echo ""
        echo " IMPORTANT: If you encounter syntax errors later, run:"
        echo "   source ~/.bashrc"
        echo " Or restart your terminal to ensure nvm environment is loaded."
    else
        echo " Error: Node.js installation verification failed"
        echo " Please restart your terminal and run the script again"
        exit 1
    fi
}

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo " Node.js is not installed!"
    echo ""
    echo "Puppeteer Scanner requires Node.js v20.0.0 or higher."
    echo "We recommend installing via nvm (Node Version Manager) for best compatibility."
    echo ""
    read -p "Would you like to install Node.js LTS via nvm? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        install_nodejs_via_nvm
    else
        echo "Please install Node.js v20+ manually:"
        echo "  - Via nvm (recommended): wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
        echo "  - Via NodeSource: wget -qO- https://deb.nodesource.com/setup_lts.x | sudo -E bash -"
        echo "  - Direct download: https://nodejs.org/"
        exit 1
    fi
fi

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2)
REQUIRED_VERSION="20.0.0"

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
    echo " Node.js version $NODE_VERSION detected. Version 20.0.0 or higher is required for Puppeteer."
    echo ""
    if command -v nvm &> /dev/null; then
        echo "Upgrading Node.js to latest LTS..."
        nvm install --lts
        nvm use --lts
        nvm alias default lts/*
        echo " Node.js upgraded to $(node --version)"
    else
        echo "Please upgrade Node.js:"
        echo "  Option 1 - Install nvm and upgrade:"
        echo "    wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
        echo "    source ~/.bashrc"
        echo "    nvm install --lts"
        echo ""
        echo "  Option 2 - Use NodeSource repository:"
        echo "    wget -qO- https://deb.nodesource.com/setup_lts.x | sudo -E bash -"
        echo "    sudo apt-get install -y nodejs"
        echo ""
        read -p "Continue with current version anyway? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
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
        # Install Chrome dependencies
        sudo apt-get install -y -qq \
            wget \
            unzip \
            libnss3 \
            libatk-bridge2.0-0 \
            libdrm2 \
            libxss1 \
            libxrandr2 \
            libpangocairo-1.0-0 \
            libatk1.0-0 \
            libcairo-gobject2 \
            libgtk-3-0 \
            libgdk-pixbuf2.0-0 \
            libgbm1 \
            libxshmfence1 \
            libxcomposite1 \
            libxdamage1 \
            libxfixes3 \
            libxkbcommon0 \
            libatspi2.0-0 \
            fonts-liberation \
            libcups2 \
            libdbus-1-3 \
            libxcb1 \
            libxkbcommon0 \
            libx11-6 \
            libxcb-dri3-0 \
            ca-certificates
        # Try to install libasound2t64, fallback to libasound2 for older systems
        sudo apt-get install -y -qq libasound2t64 2>/dev/null || sudo apt-get install -y -qq libasound2 || true
        echo " Chrome dependencies installed successfully"
    elif command -v yum &> /dev/null; then
        echo " Installing Chrome dependencies via yum..."
        sudo yum install -y -q \
            wget \
            unzip \
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
            wget \
            unzip \
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
        echo "   Ubuntu/Debian: sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxss1 libxrandr2 libasound2t64 libpangocairo-1.0-0 libatk1.0-0 libcairo-gobject2 libgtk-3-0 libgdk-pixbuf2.0-0 libgbm1 libxshmfence1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libatspi2.0-0 fonts-liberation"
        echo "   CentOS/RHEL: sudo yum install nss atk at-spi2-atk libdrm libxss libXrandr alsa-lib pango cairo-gobject gtk3 gdk-pixbuf2 mesa-libgbm libxshmfence"
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
    
    # Create chromium directory
    mkdir -p "$CHROME_DIR"
    
    # Download Chrome Headless Shell using wget
    wget -q --show-progress -O chrome-headless-shell-linux64.zip "$CHROME_URL"
    
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
            echo "   Ubuntu/Debian: sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxss1 libxrandr2 libasound2t64 libpangocairo-1.0-0 libatk1.0-0 libcairo-gobject2 libgtk-3-0 libgdk-pixbuf2.0-0 libgbm1 libxshmfence1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libatspi2.0-0 fonts-liberation"
            echo "   CentOS/RHEL: sudo yum install nss atk at-spi2-atk libdrm libxss libXrandr alsa-lib pango cairo-gobject gtk3 gdk-pixbuf2 mesa-libgbm libxshmfence"
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
