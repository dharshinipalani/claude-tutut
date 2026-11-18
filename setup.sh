#!/bin/bash
# ============================================================
# Claude Permission Watcher — Setup Script
# ============================================================
# Registers the native messaging host with Chrome/Chromium
# so the Chrome extension can talk to the desktop popup app.
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
# ============================================================

set -e

echo "🛡️  Claude Permission Watcher — Setup"
echo "========================================"
echo ""

# ----------------------------------------------------------
# Detect OS
# ----------------------------------------------------------
OS="unknown"
case "$(uname -s)" in
    Darwin*)  OS="mac";;
    Linux*)   OS="linux";;
    MINGW*|MSYS*|CYGWIN*)  OS="windows";;
esac
echo "🖥️  Detected OS: $OS"

# ----------------------------------------------------------
# Get the project directory (where this script lives)
# ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "📁 Project directory: $SCRIPT_DIR"

# ----------------------------------------------------------
# Make host.py executable
# ----------------------------------------------------------
if [ ! -x "$SCRIPT_DIR/native-host/host.py" ]; then
    chmod +x "$SCRIPT_DIR/native-host/host.py" 2>/dev/null || {
        echo "❌ host.py isn't executable and you can't chmod it (owned by another user)."
        echo "   Ask its owner to run: chmod +x $SCRIPT_DIR/native-host/host.py"
        exit 1
    }
fi
echo "✅ host.py is executable"

# The native host must be registered for the account that runs Chrome
if pgrep -x chrome >/dev/null && ! pgrep -u "$(id -u)" -x chrome >/dev/null; then
    CHROME_USER="$(ps -o user= -p "$(pgrep -x chrome | head -1)")"
    echo "⚠️  Chrome is running as '$CHROME_USER', but you are '$(whoami)'."
    echo "   Run this script as '$CHROME_USER' (from a terminal on that desktop),"
    echo "   otherwise Chrome won't find the tutut app."
    read -p "   Continue anyway? [y/N] " ans
    [ "$ans" = "y" ] || exit 1
fi

if ! /usr/bin/python3 -c "import tkinter" 2>/dev/null; then
    echo "❌ Python tkinter is missing. Install it first:"
    echo "   Debian/Ubuntu: sudo apt install python3-tk"
    echo "   Fedora:        sudo dnf install python3-tkinter"
    echo "   macOS (brew):  brew install python-tk"
    exit 1
fi
echo "✅ tkinter available (fallback popup)"

if /usr/bin/python3 -c "import gi; gi.require_version('Gtk','3.0'); gi.require_version('WebKit2','4.1'); from gi.repository import Gtk, WebKit2" 2>/dev/null; then
    echo "✅ GTK3 + WebKit2 available — the tutut island will be used"
else
    echo "⚠️  GTK3/WebKit2 not found — a plain fallback popup will be used instead of the tutut island."
    echo "   To get the island: sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1"
fi

# ----------------------------------------------------------
# Ask for the Chrome extension ID
# ----------------------------------------------------------
echo ""
echo "📋 To get your extension ID:"
echo "   1. Open Chrome → chrome://extensions"
echo "   2. Enable 'Developer mode' (top right)"
echo "   3. Click 'Load unpacked' → select the 'extension' folder"
echo "   4. Copy the extension ID shown under the extension name"
echo ""
EXTENSION_ID="${1:-}"
if [ -z "$EXTENSION_ID" ]; then
    read -p "🔑 Enter your Chrome extension ID: " EXTENSION_ID
fi
EXTENSION_ID="$(echo "$EXTENSION_ID" | tr -d '[:space:]')"
if ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    echo "❌ '$EXTENSION_ID' doesn't look like an extension ID (32 letters a–p)."
    exit 1
fi

if [ -z "$EXTENSION_ID" ]; then
    echo "❌ Extension ID is required. Exiting."
    exit 1
fi

# ----------------------------------------------------------
# Update the native messaging manifest
# ----------------------------------------------------------
MANIFEST_SRC="$SCRIPT_DIR/native-host/com.claude.permission_watcher.json"
HOST_PATH="$SCRIPT_DIR/native-host/host.py"

# Create the actual manifest
cat > "$MANIFEST_SRC" << EOF
{
  "name": "com.claude.permission_watcher",
  "description": "Claude Permission Watcher — Desktop popup for MCP permission approvals",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "✅ Updated native messaging manifest with extension ID"

# ----------------------------------------------------------
# Install the native messaging manifest
# ----------------------------------------------------------
MANIFEST_NAME="com.claude.permission_watcher.json"

if [ "$OS" = "mac" ]; then
    # macOS: Chrome and Chromium paths
    CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROMIUM_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"

    mkdir -p "$CHROME_DIR"
    cp "$MANIFEST_SRC" "$CHROME_DIR/$MANIFEST_NAME"
    echo "✅ Installed manifest to Chrome: $CHROME_DIR"

    if [ -d "$HOME/Library/Application Support/Chromium" ]; then
        mkdir -p "$CHROMIUM_DIR"
        cp "$MANIFEST_SRC" "$CHROMIUM_DIR/$MANIFEST_NAME"
        echo "✅ Installed manifest to Chromium: $CHROMIUM_DIR"
    fi

elif [ "$OS" = "linux" ]; then
    # Linux: Chrome and Chromium paths
    CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROMIUM_DIR="$HOME/.config/chromium/NativeMessagingHosts"

    mkdir -p "$CHROME_DIR"
    cp "$MANIFEST_SRC" "$CHROME_DIR/$MANIFEST_NAME"
    echo "✅ Installed manifest to Chrome: $CHROME_DIR"

    if [ -d "$HOME/.config/chromium" ]; then
        mkdir -p "$CHROMIUM_DIR"
        cp "$MANIFEST_SRC" "$CHROMIUM_DIR/$MANIFEST_NAME"
        echo "✅ Installed manifest to Chromium: $CHROMIUM_DIR"
    fi

    BRAVE_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    if [ -d "$HOME/.config/BraveSoftware/Brave-Browser" ]; then
        mkdir -p "$BRAVE_DIR"
        cp "$MANIFEST_SRC" "$BRAVE_DIR/$MANIFEST_NAME"
        echo "✅ Installed manifest to Brave: $BRAVE_DIR"
    fi

elif [ "$OS" = "windows" ]; then
    echo ""
    echo "⚠️  Windows detected. Manual registry step needed:"
    echo ""
    echo "   Run this in PowerShell (as admin):"
    echo ""
    echo "   New-Item -Path 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.claude.permission_watcher' -Force"
    echo "   Set-ItemProperty -Path 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.claude.permission_watcher' -Name '(Default)' -Value '$MANIFEST_SRC'"
    echo ""
fi

# ----------------------------------------------------------
# Done
# ----------------------------------------------------------
echo ""
echo "========================================"
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Open chrome://extensions and click the ↻ reload icon on"
echo "      Claude Permission Watcher (so it connects to the native host)"
echo "   2. Reload any open claude.ai tabs"
echo "   3. Go to claude.ai and start chatting"
echo "   4. Enable 'Always ask' for a connector in Settings → Connectors"
echo "   5. When Claude asks permission, tutut drops down from the top of your screen!"
echo ""
echo "🧪 Preview the island without Chrome:"
echo "   $SCRIPT_DIR/native-host/host.py --demo"
echo ""
echo "========================================"
