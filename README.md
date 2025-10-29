# Puppeteer Scanner

A powerful web scanner tool using Puppeteer to analyze webpage resources, domains, and network connections with optional proxy support and TCP fallback capabilities.

## Features

- **Detailed Resource Analysis**: Records comprehensive resource information (URL, domain, type, method)
- **Domain Tracking**: Monitors domains and their success/failure status
- **Proxy Support**: Optional proxy integration with QUIC protocol support
- **TCP Fallback**: Automatic fallback to TCP on QUIC connection failures
- **CSV Export**: Detailed reporting with failed domains and error information
- **Statistics**: Comprehensive statistics on resource and domain loading success rates
- **Language Detection**: Automatic language detection with Unicode pattern matching
- **Modular Architecture**: Clean, maintainable codebase with separated concerns

## Quick Start

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/soyongkim/puppeteer-scanner.git
   cd puppeteer-scanner
   ```

2. **Run the installation script:**
   ```bash
   chmod +x install.sh
   ./install.sh
   ```

   **If the main installation script fails, try the simple installer:**
   ```bash
   chmod +x simple-install.sh
   ./simple-install.sh
   ```

   The installation script will:
   - Check for Node.js installation (offers to install via nvm if missing)
   - Install all required dependencies
   - Download and setup Chrome Headless Shell automatically
   - Verify all components are working correctly
   - Provide setup guidance

### Prerequisites

**Important: Node.js v14.0.0 or higher is required** for full compatibility with modern JavaScript features.

**Option 1: Use the install script (Recommended):**
```bash
chmod +x install.sh
./install.sh
```

**Option 2: Manual Node.js Installation via nvm:**

```bash
# Install nvm (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Restart your terminal or source the profile
source ~/.bashrc  # or ~/.zshrc

# Install latest LTS Node.js
nvm install --lts
nvm use --lts

# Then install dependencies
npm install
```

**Option 3: System Package Manager:**

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nodejs npm

# CentOS/RHEL/Fedora
sudo dnf install nodejs npm
# or for older versions: sudo yum install nodejs npm

# Then install dependencies
npm install
```

**System Dependencies:**

The installer will automatically download Chrome Headless Shell, but you may need these system libraries:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install wget unzip libnss3 libatk-bridge2.0-0 libdrm2 libxss1 libgconf-2-4 libxrandr2 libasound2 libpangocairo-1.0-0 libatk1.0-0 libcairo-gobject2 libgtk-3-0 libgdk-pixbuf2.0-0

# CentOS/RHEL
sudo yum install wget unzip
```

**Other Requirements:**
- npm or yarn package manager

## Usage

### Basic Usage

```bash
node puppeteer-client.js --url=example.com
```

### Advanced Usage

```bash
# With proxy support
node puppeteer-client.js --url=example.com --use-proxy

# With proxy and TCP fallback
node puppeteer-client.js --url=example.com --use-proxy --tcp-fallback

# Custom CSV output file
node puppeteer-client.js --url=example.com --csv=my_analysis.csv

# Disable language detection
node puppeteer-client.js --url=example.com --no-lang

# With debug output
node puppeteer-client.js --url=example.com --debug

# Complete example
node puppeteer-client.js --url=example.com --use-proxy --tcp-fallback --csv=detailed_analysis.csv --debug
```

### Command Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--url` | Target URL to scan (required) | - |
| `--use-proxy` | Enable proxy mode | `false` |
| `--tcp-fallback` | Enable TCP fallback on QUIC failures | `false` |
| `--no-lang` | Disable language detection | `false` (detection enabled by default) |
| `--debug` | Enable detailed debug output | `false` |
| `--csv` | Output CSV filename | `webpage_analysis_results.csv` |

## Proxy Setup

When using `--use-proxy=true`, the scanner expects:
- Proxy server running on `http://localhost:4433`
- Statistics endpoint available at `http://localhost:9090/stats`

The proxy should support QUIC protocol with optional TCP fallback capabilities.

## Output

The scanner generates:

1. **Console Output**: Real-time logging of network requests, responses, and analysis
2. **CSV File**: Detailed report including:
   - Resource URLs and domains
   - Success/failure status
   - Error details for failed requests
   - Language detection results (primary and declared languages)
   - Geo-blocking detection results
   - Performance metrics
   - Proxy statistics (when using proxy mode)

## Technical Details

### Chrome Binary

The scanner uses a specific Chrome Headless Shell binary (version 140.0.7339.82) for consistent results across environments. This binary is automatically downloaded during installation to `./chromium/chrome-headless-shell-linux64/chrome-headless-shell`.

### Dependencies

- **puppeteer-core**: Headless Chrome automation
- **node-fetch**: HTTP request library
- Built-in Node.js modules: `dns/promises`, `fs`, `path`

### Architecture

The codebase is organized into a modular architecture:

- **`puppeteer-client.js`**: Main entry point and CLI interface
- **`src/scanner/`**: Core scanning functionality and browser management
- **`src/analysis/`**: Result processing, language detection, and domain analysis
- **`src/config/`**: Configuration and argument parsing
- **`src/utils/`**: Utility functions for domains, CSV export, and logging
- **`src/browser/`**: Browser launcher and setup

## Troubleshooting

### Installation Issues

**Install Script Fails:**
If `./install.sh` fails, try manual installation:

```bash
# Method 1: Manual nvm installation
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh -o install-nvm.sh
bash install-nvm.sh
source ~/.bashrc
nvm install --lts
nvm use --lts
npm install

# Method 2: System package manager
# Ubuntu/Debian:
sudo apt update && sudo apt install nodejs npm
npm install

# Method 3: Direct Node.js download
# Visit https://nodejs.org/ and download the installer
```

**nvm Installation Fails:**
```bash
# Ensure curl is installed
sudo apt install curl  # Ubuntu/Debian
sudo dnf install curl  # Fedora/RHEL

# Try alternative nvm installation
wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
```

### Node.js Issues

**Syntax Error with Optional Chaining (`?.`):**
If you see `SyntaxError: Unexpected token '.'`, your Node.js version is too old.

```bash
# Check your Node.js version
node --version

# If version is below v14.0.0, upgrade:
# Via nvm (recommended):
nvm install --lts
nvm use --lts

# Or try the simple installer:
./simple-install.sh
```

**Node.js Not Found:**
```bash
# Install via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm use --lts
```

**Wrong Node.js Version:**
```bash
# If you have nvm installed
nvm install --lts
nvm use --lts

# Or install a specific version
nvm install 18.17.0
nvm use 18.17.0
```

**Multiple Node.js Versions:**
```bash
# List installed versions
nvm list

# Switch between versions
nvm use 16.20.0
nvm use --lts

# Set default version
nvm alias default node
```

### Chrome/Chromium Issues

**Chrome Headless Shell Download Failed:**
```bash
# Manual download and setup
mkdir -p chromium
cd chromium
wget https://storage.googleapis.com/chrome-for-testing-public/140.0.7339.82/linux64/chrome-headless-shell-linux64.zip
unzip chrome-headless-shell-linux64.zip
chmod +x chrome-headless-shell-linux64/chrome-headless-shell
cd ..
```

**Chrome Binary Issues:**
```bash
# Install required system libraries (Ubuntu/Debian)
sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxss1 libgconf-2-4 libxrandr2 libasound2 libpangocairo-1.0-0 libatk1.0-0 libcairo-gobject2 libgtk-3-0 libgdk-pixbuf2.0-0

# Test Chrome binary
./chromium/chrome-headless-shell-linux64/chrome-headless-shell --version
```

**Alternative Chrome Installation:**
If the automatic Chrome download doesn't work, you can install system Chrome:

```bash
# Ubuntu/Debian
sudo apt-get install chromium-browser

# CentOS/RHEL
sudo yum install chromium

# macOS
brew install --cask google-chrome
```

Then modify the `executablePath` in `src/browser/launcher.js` to point to your system Chrome.

### Proxy Connection Issues

Ensure your proxy server is running and accessible:
- Check `http://localhost:4433` is reachable
- Verify stats endpoint `http://localhost:9090/stats` responds
- Review proxy server logs for connection issues

### Permission Issues

Make sure the installation script is executable:
```bash
chmod +x install.sh
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

**soyongkim**
- GitHub: [@soyongkim](https://github.com/soyongkim)
- Repository: [puppeteer-scanner](https://github.com/soyongkim/puppeteer-scanner)
