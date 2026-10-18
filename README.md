# steam-inplace-patcher

Update huge Steam games **in place**, without needing free space for a full staging copy.
Built for ARK: Survival Ascended and its 191 GB pak file.

## The problem

Steam updates a game by building a complete new copy of every changed file before it swaps the copy in.
ARK: Survival Ascended keeps almost all of its content in one 191 GB file (`pakchunk0-Windows.ucas`).
As a result, an 8 GB patch needs **~210 GB of free disk space**.

## How it works

1. Compares the installed depot manifest with the latest one, chunk by chunk.
2. Downloads only the chunks that are new (~8 GB), into a small stash next to the tool.
3. Rearranges the existing data **inside the file itself**. It orders the writes so that no data is overwritten before it has been read; where moves depend on each other in a cycle, it stashes one chunk to break it.
4. Checks every chunk with SHA-1 and re-downloads anything that doesn't match.
5. Updates Steam's app manifest so Steam recognizes the new build.

Result: the update needs **~10 GB** of free space instead of ~210 GB.

## Features

- In-place patching with cycle-safe write ordering
- Downloads only the changed chunks; interrupted runs resume where they stopped
- SHA-1 verification with automatic repair
- QR login via the Steam mobile app, so you never type your password into the tool
- Single `.exe`, no install needed; finds your Steam library automatically
- Simple progress page in your browser: one bar for download and installing

## Usage

1. Exit Steam completely (right-click the tray icon > **Exit**).
2. Put `ark-patcher.exe` in a folder you can write to (e.g. Desktop, not Program Files) with ~10 GB free.
3. Double-click it, then scan the QR code with the Steam app (Steam Guard > scan QR code).
4. When it's done, start Steam and run **Properties > Installed Files > Verify integrity** once.

### Command line

```bash
ark-patcher.exe plan     # offline: show what would change
ark-patcher.exe apply    # download, patch in place, verify
ark-patcher.exe verify   # check every changed file, repair mismatches
ark-patcher.exe fixacf   # mark the game as updated in Steam
```

### Build from source

```bash
npm install
node build.js            # creates dist/ark-patcher.exe
```

## Requirements

- Windows 10/11, 64-bit
- A Steam account that owns the game
- ~10 GB free disk space

## Notes

- The tool saves its Steam login token in `state/refresh-token.txt`, next to the exe. Never share or commit that folder.
- Windows SmartScreen may warn because the exe is unsigned: **More info > Run anyway**.

## Disclaimer

Unofficial; not affiliated with Valve or Studio Wildcard. Use at your own risk. In the worst case you have to re-download the game.
