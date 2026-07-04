#!/bin/bash
cd "$(dirname "$0")"

echo "============================================"
echo "  Narrative Engine - Repair Tool"
echo "============================================"
echo ""
echo "This tool fixes one common problem:"
echo ""
echo "  The app's internal database file was built"
echo "  for an older version of Node.js (the software"
echo "  that runs this app). It needs to be rebuilt"
echo "  to match the version of Node you have now."
echo ""
echo "You might need this if:"
echo "  - You upgraded Node.js and the app stopped working"
echo "  - You see an error mentioning 'NODE_MODULE_VERSION'"
echo "  - start.sh told you to run this"
echo ""
echo "IMPORTANT: Before continuing, please make sure"
echo "the Narrative Engine app is fully closed:"
echo "  - Close any app windows"
echo "  - Close any terminal windows running the app"
echo "  - If you ran './start.sh' or 'npm run dev' in a"
echo "    terminal, close that terminal"
echo ""
echo "============================================"
echo ""

# ===== Pre-flight: Node must be installed and new enough =====
if ! command -v node >/dev/null 2>&1; then
    echo "[STOP] Node.js is not installed on this computer."
    echo ""
    echo "To fix this:"
    echo "  1. Open your web browser and go to https://nodejs.org/"
    echo "  2. Download the 'LTS' version (the green button)"
    echo "  3. Install it, then run this script again"
    echo ""
    exit 1
fi

NODE_VERSION=$(node -p "process.versions.node" 2>/dev/null)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
NODE_MAJOR=$(echo "$NODE_MAJOR" | sed 's/^0*//')
NODE_MINOR=$(echo "$NODE_MINOR" | sed 's/^0*//')
[ -z "$NODE_MAJOR" ] && NODE_MAJOR=0
[ -z "$NODE_MINOR" ] && NODE_MINOR=0

REQUIRED_MAJOR=20
REQUIRED_MINOR=19

NODE_OK=0
if [ "$NODE_MAJOR" -gt "$REQUIRED_MAJOR" ]; then
    NODE_OK=1
elif [ "$NODE_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$NODE_MINOR" -ge "$REQUIRED_MINOR" ]; then
    NODE_OK=1
fi

if [ "$NODE_OK" -eq 0 ]; then
    echo "[STOP] Your Node.js is too old (version $NODE_VERSION)."
    echo ""
    echo "This app needs Node 20.19 or newer. This repair tool cannot help yet."
    echo ""
    echo "To fix this:"
    echo "  1. Open your web browser and go to https://nodejs.org/"
    echo "  2. Download the 'LTS' version (the green button)"
    echo "  3. Install it, then run this script again"
    echo ""
    exit 1
fi

echo "Node $NODE_VERSION detected - OK."
echo ""

# ===== Consent gate =====
echo "============================================"
echo "  What this tool will do:"
echo "============================================"
echo ""
echo "  1. Run a repair command that rebuilds the"
echo "     app's database file to match your current"
echo "     Node version."
echo "  2. This takes about 1 to 2 minutes. A lot of"
echo "     text will scroll by - that is normal,"
echo "     please do not close the window."
echo ""
echo "  What it will NOT do:"
echo "    - It will NOT change your Node.js version"
echo "    - It will NOT delete your saved campaigns"
echo "      or any of your data"
echo "    - It will NOT touch any other programs"
echo "      on your computer"
echo "    - It only fixes one internal file inside"
echo "      this app's folder"
echo ""
echo "  If it fails, nothing harmful happens - it"
echo "  will simply tell you what went wrong and"
echo "  what to install."
echo ""
echo "============================================"
echo ""
read -p "Type YES to continue, or press any other key and Enter to cancel: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
    echo ""
    echo "Cancelled. No changes were made to your computer."
    echo "You can run this script again any time."
    echo ""
    exit 0
fi

echo ""
echo "============================================"
echo "  Starting the repair. Please do not close"
echo "  this window. This takes 1-2 minutes."
echo "============================================"
echo ""

# ===== Rebuild better-sqlite3 =====
npm rebuild better-sqlite3
if [ $? -ne 0 ]; then
    echo ""
    echo "============================================"
    echo "  The repair did not finish."
    echo "============================================"
    echo ""
    echo "This usually means your computer is missing"
    echo "the C++ build tools needed to rebuild the"
    echo "database file. Install them with one of these"
    echo "commands, then run this script again:"
    echo ""
    echo "  Debian/Ubuntu:  sudo apt install build-essential python3"
    echo "  Fedora/RHEL:    sudo dnf install gcc-c++ make python3"
    echo "  macOS:          xcode-select --install"
    echo ""
    exit 1
fi

echo ""
echo "============================================"
echo "  Repair complete!"
echo "============================================"
echo ""
echo "The database file has been rebuilt for Node $NODE_VERSION."
echo ""
echo "Next step: run ./start.sh to start the app."
echo ""
exit 0