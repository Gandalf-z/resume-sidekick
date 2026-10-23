#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -c 'import json,pathlib; print(json.loads(pathlib.Path("'"$ROOT"'/extension/manifest.json").read_text())["version"])')"
OUT="$ROOT/dist/resume-sidekick-v$VERSION-source.zip"
mkdir -p "$ROOT/dist"
node --check "$ROOT/extension/sidepanel.js"
node --check "$ROOT/extension/resume-parser.mjs"
node --check "$ROOT/extension/service-worker.js"
(cd "$ROOT/extension" && npm test)
python3 - "$ROOT/extension/manifest.json" <<'PYMANIFEST'
import json, sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text())
assert m.get('manifest_version') == 3
assert m.get('version')
print('Manifest OK:', m['name'], m['version'])
PYMANIFEST
rm -f "$OUT"
cd "$ROOT"
zip -qr -X "$OUT" README.md LICENSE CHANGELOG.md extension
echo "Package created: $OUT"
