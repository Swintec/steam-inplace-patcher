# steam-inplace-patcher

Update huge Steam games **in place**, without needing free space for a full staging copy.
Originally built for ARK: Survival Ascended and its 191 GB pak file; works for any Steam game.

## The problem

Steam updates a game by building a complete new copy of every changed file before it swaps the copy in.
Games that pack their content into a few giant files therefore need enormous free space for small patches.
ARK: Survival Ascended keeps almost everything in one 191 GB file (`pakchunk0-Windows.ucas`),
so an 8 GB patch needs **~210 GB of free disk space**.

## How it works

1. Reads the installed build from Steam's app manifest and asks Steam for the latest depot manifests.
2. Compares old and new manifests chunk by chunk, per depot.
3. Downloads only the chunks that are new, into a small stash next to the tool.
4. Rearranges the existing data **inside the files themselves**. It orders the writes so that no data is overwritten before it has been read; where moves depend on each other in a cycle, it stashes one chunk to break it.
5. Checks every chunk with SHA-1 and re-downloads anything that doesn't match.
6. Updates Steam's app manifest so Steam recognizes the new build.

For the ARK update that meant downloading 7.3 GB and needing **~10 GB** of free space instead of ~210 GB.

## Features

- Pick any installed game from a dropdown (games with a pending update are listed first)
- Finds the latest depots and manifests automatically, including beta branches you're opted into
- Closes Steam automatically before patching
- In-place patching with cycle-safe write ordering
- Downloads only the changed chunks; interrupted runs resume where they stopped
- SHA-1 verification with automatic repair
- QR login via the Steam mobile app, so you never type your password into the tool
- Single `.exe`, no install needed; finds all your Steam libraries
- Progress page in your browser with one bar: download and installing

## Usage

1. Put `steam-inplace-patcher.exe` in a folder you can write to (e.g. Desktop, not Program Files), on a drive with a few GB free.
2. Double-click it. A page opens in your browser.
3. Choose a game and click **Update**. Steam is closed automatically.
4. The first time, scan the QR code with the Steam app (Steam Guard > scan QR code).
5. When it's done, start Steam. Optionally run **Properties > Installed Files > Verify integrity** once.

### Command line

```bash
steam-inplace-patcher.exe                  # browser UI with game picker
steam-inplace-patcher.exe list             # installed games and app IDs
steam-inplace-patcher.exe plan 2399830     # offline: what would change
steam-inplace-patcher.exe apply 2399830    # update a game in place
steam-inplace-patcher.exe verify 2399830   # check changed files, repair mismatches
steam-inplace-patcher.exe -debug           # browser UI with download diagnostics
```

Add `-debug` (or `--debug`) anywhere in the command to write a timestamped
`debug-*.log` next to the exe. It records download servers, each chunk attempt,
timings, decompression frame metadata and full error stacks. Share that log when
reporting a download failure. Login tokens and QR codes are not recorded.

### Build from source

```bash
npm install
node build.js            # creates dist/steam-inplace-patcher.exe
node test-schedule.js    # randomized test of the in-place write ordering
```

## When it helps

It pays off for games whose content sits in a few huge files (many Unreal Engine games, ARK, Baldur's Gate 3).
For games made of many small files Steam already needs little extra space, so there is little to gain.

## Requirements

- Windows 10/11, 64-bit
- A Steam account that owns the game
- Free space for the downloaded chunks (roughly the size of the patch)

## Notes

- The tool saves its Steam login token in `state/refresh-token.txt`, next to the exe. Never share or commit that folder.
- Windows SmartScreen may warn because the exe is unsigned: **More info > Run anyway**.
- Password-protected beta branches are not supported.

## Disclaimer

Unofficial; not affiliated with Valve or any game developer. Use at your own risk. In the worst case you have to re-download the game.
