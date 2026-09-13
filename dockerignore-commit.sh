#!/usr/bin/env bash
set -euo pipefail
# Starfare chore: trim the Docker build context/image (assets library + docs stay in git).
# Run from repo root: gitserver@gitserver:/mnt/git-server/starfare  (does NOT push)
test -f Dockerfile || { echo "!! run me from the starfare repo root"; exit 1; }

python3 - <<'PYEOF'
import base64
new = base64.b64decode("IyBLZWVwIHRoZSBidWlsZCBjb250ZXh0IGxlYW4gYW5kIHRoZSBpbWFnZSByZXByb2R1Y2libGUuCi5naXQKZGV2LwoKIyBOb3Qgc2VydmVkIGF0IHJ1bnRpbWUg4oCUIGRlc2lnbiBkb2NzIGFuZCBkZXYtb25seSB0b29saW5nIHN0YXkgaW4gZ2l0IGJ1dAojIG5ldmVyIG5lZWQgdG8gZW50ZXIgdGhlIGltYWdlICh0aGV5IHdlcmUgfjIwIE1CIG9mIGJ1aWxkIGNvbnRleHQgZm9yIG5vdGhpbmcpLgpkb2NzLwp0b29scy8KCiMgVGhlIGF1ZGlvIExJQlJBUlkgc3RheXMgaW4gdGhlIHJlcG8gYnV0IG11c3Qgbm90IGJsb2F0IHRoZSBydW50aW1lIGltYWdlOiB0aGUKIyBnYW1lIGVtYmVkcyBpdHMgc2h1ZmZsZSBwbGF5bGlzdCBhcyBiYXNlNjQgaW4gZ2FtZS5odG1sLCBhbmQgb25seSB0aGUgdGl0bGUKIyB0cmFjayBpcyBldmVyIGxvYWRlZCBieSBmaWxlLiBTaGlwIHRoYXQgb25lOyBsZWF2ZSB0aGUgb3RoZXIgfjIxNSBNQiBvdXQuCmNsaWVudC9hc3NldHMvYXVkaW8vKgohY2xpZW50L2Fzc2V0cy9hdWRpby9tYWluLXRpdGxlLm1wMwo=").decode("utf-8")
p = ".dockerignore"
cur = open(p, encoding="utf-8").read()
# fail loud if the repo isn't in the state we inspected
assert ".git" in cur and "dev/" in cur, ".dockerignore missing expected baseline"
assert "client/assets/audio" not in cur, ".dockerignore already trimmed — nothing to do"
open(p, "w", encoding="utf-8").write(new)
print(".dockerignore trimmed: docs/, tools/, and the unused audio excluded from the image")
PYEOF

# safety: the ONE audio file the game loads by URL must survive the ignore rules
grep -q "!client/assets/audio/main-title.mp3" .dockerignore && echo "  main-title.mp3 re-included: OK"

git add .dockerignore
git commit -m "chore: trim the Docker build context — keep the asset library in git, out of the image

The Dockerfile COPY . . baked the whole 275MB tree into every image tag: 220MB of
audio (38 of 39 tracks referenced nowhere; the game embeds its playlist as base64 and
loads only main-title.mp3 by file), plus docs/ and tools/ the runtime never serves.
That is the 287MB build context in the deploy logs and a driver of the host disk-full
(runbook 11). This excludes them from the image only — nothing leaves git, fully
reversible. Build context drops to a few MB; the served game is unchanged (main-title
re-included, base64 playlist lives in game.html)."

echo; echo "Done. Review: git show HEAD ; then: git push origin main"
