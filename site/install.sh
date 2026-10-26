#!/bin/sh
# ascian installer. Readable on purpose: it fetches one file into ~/.ascian
# and puts a launcher on your PATH. Nothing else.
set -e
ORIGIN="${ASCIAN_ORIGIN:-https://ascian.fun}"
command -v node >/dev/null 2>&1 || { echo "Node 18 or newer is needed: https://nodejs.org"; exit 1; }
mkdir -p "$HOME/.ascian" "$HOME/.local/bin"
curl -fsSL "$ORIGIN/cli/ascian.mjs" -o "$HOME/.ascian/ascian.mjs"
printf '#!/bin/sh\nexec node "$HOME/.ascian/ascian.mjs" "$@"\n' > "$HOME/.local/bin/ascian"
chmod +x "$HOME/.local/bin/ascian"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$rc" ] && ! grep -q '.local/bin' "$rc" && echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
  done
  echo "Added ~/.local/bin to PATH. Open a new terminal tab.";;
esac
echo "Installed. Next: ascian login"
