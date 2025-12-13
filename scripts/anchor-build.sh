#!/bin/bash

set -e

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# sync program address
anchor keys sync

# compile the program
anchor build

# Copy program type and IDL to app/src/idl/

# type is at target/types/flappy_bird.ts
# IDL is at target/idl/flappy_bird.json

# copy type
cp "$PROJECT_ROOT/target/types/flappy_bird.ts" "$PROJECT_ROOT/app/src/idl/flappy_bird.ts"

# copy IDL
cp "$PROJECT_ROOT/target/idl/flappy_bird.json" "$PROJECT_ROOT/app/src/idl/flappy_bird.json"

