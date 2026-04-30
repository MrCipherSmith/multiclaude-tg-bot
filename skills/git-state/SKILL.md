---
name: git-state
description: "Use when you need a snapshot of the current git working state."
version: 1.0.0
author: helyx
license: MIT
---

# Git State Snapshot

Branch: !`git rev-parse --abbrev-ref HEAD`

Last commit: !`git log -1 --format='%h %s (%an, %ar)'`

Working tree:

```
!`git status --short`
```

Diff summary:

```
!`git diff --stat`
```
