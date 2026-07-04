#!/bin/bash
cd "$(dirname "$0")"

echo "============================================"
echo "  Narrative Engine - Repair Tool"
echo "============================================"
echo ""
echo "This tool can fix two common problems that"
echo "stop the app from starting."
echo ""
echo "You might need this if:"
echo "  - You upgraded Node.js and the app stopped working"
echo "  - You see an error mentioning 'NODE_MODULE_VERSION'"
echo "  - You see an error about 'native binding', 'rolldown',"
echo "    'Cannot find module', or 'is not a valid Win32"
echo "    application'"
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

# ===== Menu =====
menu() {
    echo "============================================"
    echo "  What kind of problem are you having?"
    echo "============================================"
    echo ""
    echo "  1) Quick fix - rebuild the database file only"
    echo "     Use this if you upgraded Node.js and the app"
    echo "     stopped working with a 'NODE_MODULE_VERSION'"
    echo "     error. Takes 1-2 minutes. Keeps your current"
    echo "     installed dependencies."
    echo ""
    echo "  2) Full clean reinstall - delete everything and"
    echo "     start fresh"
    echo "     Use this if the app won't start and you see"
    echo "     errors about 'native binding', 'rolldown',"
    echo "     'Cannot find module', or anything else from"
    echo "     Vite. Takes 3-5 minutes. Downloads all"
    echo "     dependencies again."
    echo ""
    echo "  3) Cancel - don't change anything"
    echo ""
    read -p "Type 1, 2, or 3 and press Enter: " CHOICE
    echo ""
    case "$CHOICE" in
        1) quick_fix ;;
        2) clean_reinstall ;;
        3) cancel ;;
        *)
            echo "You typed '$CHOICE'. Please type 1, 2, or 3."
            echo ""
            menu
            ;;
    esac
}

cancel() {
    echo "Cancelled. No changes were made to your computer."
    echo "You can run this script again any time."
    echo ""
    exit 0
}

user_cancelled() {
    echo ""
    echo "Cancelled. No changes were made to your computer."
    echo "You can run this script again any time."
    echo ""
    exit 0
}

# ===== Option 1: Quick fix (rebuild better-sqlite3) =====
quick_fix() {
    echo "============================================"
    echo "  Quick fix: rebuild the database file"
    echo "============================================"
    echo ""
    echo "This will rebuild one internal file so it"
    echo "matches your current Node version."
    echo ""
    echo "It will NOT change your Node.js version."
    echo "It will NOT delete your saved campaigns or data."
    echo "It will NOT touch any other programs on your computer."
    echo ""
    echo "This takes 1-2 minutes. A lot of text will scroll"
    echo "by - that is normal, please do not close the window."
    echo ""
    read -p "Type YES to continue, or any other key and Enter to cancel: " CONFIRM
    if [ "$CONFIRM" != "YES" ]; then
        user_cancelled
    fi

    echo ""
    echo "Starting the rebuild. Please wait..."
    echo ""
    npm rebuild better-sqlite3
    if [ $? -ne 0 ]; then
        rebuild_failed
    fi

    echo ""
    echo "============================================"
    echo "  Quick fix complete!"
    echo "============================================"
    echo ""
    echo "The database file has been rebuilt for Node $NODE_VERSION."
    echo ""
    echo "Next step: run ./start.sh to start the app."
    echo ""
    exit 0
}

rebuild_failed() {
    echo ""
    echo "============================================"
    echo "  The quick fix did not finish."
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
    echo "Alternatively, try option 2 (Full clean reinstall)"
    echo "from the menu - it may succeed without needing"
    echo "the C++ build tools."
    echo ""
    exit 1
}

# ===== Option 2: Full clean reinstall =====
clean_reinstall() {
    echo "============================================"
    echo "  Full clean reinstall"
    echo "============================================"
    echo ""
    echo "This will delete and re-download all of the"
    echo "app's installed code files. This fixes problems"
    echo "where the install was incomplete (a known npm bug)."
    echo ""
    echo "This will do the following:"
    echo "  - Delete the 'node_modules' folder"
    echo "    (all the app's installed code files -"
    echo "     they will be re-downloaded automatically)"
    echo "  - Delete 'package-lock.json'"
    echo "    (a small file that tracks which versions"
    echo "     are installed)"
    echo "  - Run 'npm install' to download fresh copies"
    echo "    of everything"
    echo ""
    echo "This will NOT touch:"
    echo "  - Your saved campaigns, characters, or lore"
    echo "    (stored in the 'data' folder)"
    echo "  - Your API keys and settings"
    echo "  - Your Node.js installation"
    echo "  - Any other programs on your computer"
    echo ""
    echo "Your data is completely safe."
    echo ""
    echo "This takes 3-5 minutes and downloads about"
    echo "200 MB. A lot of text will scroll by - that is"
    echo "normal, please do not close the window."
    echo ""
    read -p "Type YES to continue, or any other key and Enter to cancel: " CONFIRM
    if [ "$CONFIRM" != "YES" ]; then
        user_cancelled
    fi

    echo ""
    echo "============================================"
    echo "  Starting the clean reinstall."
    echo "  Please do not close this window."
    echo "============================================"
    echo ""

    # Step 1: delete node_modules
    echo "Deleting old installed files..."
    if [ -d "node_modules" ]; then
        rm -rf node_modules
        if [ -d "node_modules" ]; then
            echo ""
            echo "[ERROR] Could not delete the 'node_modules' folder."
            echo "This usually means the app is still running."
            echo ""
            echo "Please make sure the Narrative Engine app is"
            echo "fully closed, then run this repair again."
            echo ""
            exit 1
        fi
    fi

    # Step 2: delete package-lock.json
    if [ -f "package-lock.json" ]; then
        rm -f package-lock.json
    fi

    # Step 3: fresh install
    echo ""
    echo "Downloading and installing fresh copies..."
    echo "This is the slowest step. Please be patient."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        reinstall_failed
    fi

    echo ""
    echo "============================================"
    echo "  Full clean reinstall complete!"
    echo "============================================"
    echo ""
    echo "All dependencies have been reinstalled successfully."
    echo ""
    echo "Next step: run ./start.sh to start the app."
    echo ""
    exit 0
}

reinstall_failed() {
    echo ""
    echo "============================================"
    echo "  The reinstall did not finish."
    echo "============================================"
    echo ""
    echo "This is usually a network problem - the"
    echo "installer could not download some files."
    echo ""
    echo "To fix this:"
    echo "  1. Check your internet connection"
    echo "  2. Try again in a few minutes"
    echo "  3. Run this script again and choose option 2"
    echo ""
    echo "If it keeps failing, you may need to ask for help -"
    echo "there may be a problem with your npm setup or a"
    echo "temporary issue with the download servers."
    echo ""
    exit 1
}

# ===== Run the menu =====
menu