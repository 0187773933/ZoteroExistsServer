#!/bin/bash
set -euo pipefail

is_int() { [[ "$1" =~ ^[0-9]+$ ]]; }

# ================= SSH (optional, safe to keep) =================
ssh-add -D >/dev/null 2>&1 || true
ssh-add -k /Users/morpheous/.ssh/githubWinStitch >/dev/null 2>&1 || true

# ================= GIT INIT =================
[ -d .git ] || git init

# commit metadata (does NOT affect auth, just labeling)
git config user.name  "0187773933"
git config user.email "collincerbus@student.olympic.edu"

# ================= FORCE CORRECT REMOTE =================
# Always reset origin so it NEVER points to wrong account
git remote remove origin >/dev/null 2>&1 || true
git remote add origin git@github-0187773933:0187773933/ZoteroExistsServer.git

# ================= SKIP IF NO CHANGES =================
if [ -z "$(git status --porcelain)" ]; then
	echo "Nothing to commit — working tree clean."
	exit 0
fi

# ================= AUTO-INCREMENT COMMIT =================
LastCommit=$(git log -1 --pretty="%B" 2>/dev/null | xargs || echo "0")
if is_int "$LastCommit"; then
	NextCommitNumber=$((LastCommit + 1))
else
	echo "Resetting commit number to 1"
	NextCommitNumber=1
fi

# ================= STAGE =================
git add .

# ================= COMMIT MESSAGE / TAG =================
if [ -n "${1:-}" ]; then
	CommitMsg="$1"
	Tag="v1.0.$1"
else
	CommitMsg="$NextCommitNumber"
	Tag="v1.0.$NextCommitNumber"
fi

git commit -m "$CommitMsg"

# ================= TAG CLEANUP =================
if git tag | grep -qx "$Tag"; then
	git tag -d "$Tag" >/dev/null 2>&1
fi

if git ls-remote --tags origin | grep -q "refs/tags/$Tag$"; then
	git push --delete origin "$Tag" >/dev/null 2>&1 || true
fi

git tag "$Tag"

# ================= PUSH =================
git push origin master
git push origin "$Tag"