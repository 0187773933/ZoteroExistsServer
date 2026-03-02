#!/bin/bash
set -euo pipefail

is_int() { [[ "$1" =~ ^[0-9]+$ ]]; }

ssh-add -D >/dev/null 2>&1
ssh-add -k /Users/morpheous/.ssh/githubWinStitch >/dev/null 2>&1

[ -d .git ] || git init

git config user.name  "0187773933"
git config user.email "collincerbus@student.olympic.edu"

if ! git remote | grep -qx "origin"; then
	git remote add origin git@github.com:0187773933/ZoteroExistsServer.git
fi

# skip if no changes
if [ -z "$(git status --porcelain)" ]; then
	echo "Nothing to commit — working tree clean."
	exit 0
fi

LastCommit=$(git log -1 --pretty="%B" 2>/dev/null | xargs || echo "0")
if is_int "$LastCommit"; then
	NextCommitNumber=$((LastCommit + 1))
else
	echo "Resetting commit number to 1"
	NextCommitNumber=1
fi

git add .

if [ -n "${1:-}" ]; then
	CommitMsg="$1"
	Tag="v1.0.$1"
else
	CommitMsg="$NextCommitNumber"
	Tag="v1.0.$NextCommitNumber"
fi

git commit -m "$CommitMsg"

# safely replace tag
if git tag | grep -qx "$Tag"; then
	git tag -d "$Tag" >/dev/null 2>&1
fi
if git ls-remote --tags origin | grep -q "refs/tags/$Tag$"; then
	git push --delete origin "$Tag" >/dev/null 2>&1 || true
fi

git tag "$Tag"

# Push only current branch and current tag (not all tags)
git push origin master
git push origin "$Tag"