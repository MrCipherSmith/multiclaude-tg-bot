#!/bin/bash
# Helyx — one-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/helyx/main/install.sh | bash
#
# What it does:
# 1. Checks prerequisites (git, bun, docker, claude)
# 2. Clones the repo (or updates if exists)
# 3. Installs dependencies
# 4. Installs 'helyx' CLI globally
# 5. Runs the setup wizard

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

REPO="https://github.com/MrCipherSmith/helyx.git"
INSTALL_DIR="${HELYX_DIR:-$HOME/bots/helyx}"
BIN_DIR="${HOME}/.local/bin"

echo -e "\n${BOLD}Helyx Installer${NC}\n"

# --- Check prerequisites ---

check() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $1 $(command -v "$1")"
    return 0
  else
    echo -e "  ${RED}✗${NC} $1 not found"
    return 1
  fi
}

echo -e "${BOLD}Checking prerequisites...${NC}"
MISSING=0
check git || MISSING=1
check docker || MISSING=1

if ! check bun; then
  MISSING=1
  echo -e "    ${DIM}Install: curl -fsSL https://bun.sh/install | bash${NC}"
fi

if ! check claude; then
  echo -e "    ${DIM}Install: npm install -g @anthropic-ai/claude-code${NC}"
  echo -e "    ${DIM}Optional — needed only for Claude Code sessions${NC}"
fi

if ! check opencode; then
  echo -e "    ${DIM}Optional — needed for opencode sessions. Setup wizard will install it.${NC}"
fi

if [ "$MISSING" -eq 1 ]; then
  echo -e "\n  ${RED}Install missing dependencies and try again.${NC}\n"
  exit 1
fi

# --- Clone or update ---

echo -e "\n${BOLD}Installing helyx...${NC}"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "  ${CYAN}Updating${NC} existing installation at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || {
    echo -e "  ${DIM}Pull failed (local changes?), skipping update${NC}"
  }
else
  echo -e "  ${CYAN}Cloning${NC} to $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO" "$INSTALL_DIR"
fi

# --- Install dependencies ---

echo -e "  ${CYAN}Installing${NC} dependencies..."
cd "$INSTALL_DIR"
bun install --silent 2>/dev/null || bun install

# --- Install CLI wrapper ---

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/helyx" << EOF
#!/bin/bash
exec bun --cwd "$INSTALL_DIR" "$INSTALL_DIR/cli.ts" "\$@"
EOF

chmod +x "$BIN_DIR/helyx"

# Ensure ~/.local/bin is in PATH
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  SHELL_RC=""
  [ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
  [ -f "$HOME/.bashrc" ] && SHELL_RC="${SHELL_RC:-$HOME/.bashrc}"
  if [ -n "$SHELL_RC" ]; then
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    echo -e "  ${DIM}Added $BIN_DIR to PATH in $SHELL_RC${NC}"
    export PATH="$BIN_DIR:$PATH"
  fi
fi

# --- Done ---

echo -e "\n${GREEN}${BOLD}Installed!${NC}\n"
echo -e "  CLI:  ${CYAN}helyx${NC} (in $BIN_DIR)"
echo -e "  Repo: $INSTALL_DIR\n"
echo -e "${BOLD}Running setup wizard...${NC}\n"

exec helyx setup < /dev/tty
