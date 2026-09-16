Download the file for your computer below. Your habits are stored only on your own machine.

**macOS** — `habit-calendar-macos-universal.zip` (Apple Silicon and Intel)

Install or update from Terminal:
```sh
cd ~/Downloads
curl -LO https://github.com/venom-10/habbit-tracker/releases/latest/download/habit-calendar-macos-universal.zip
ditto -x -k habit-calendar-macos-universal.zip .
rm -rf "/Applications/Habit Calendar.app"    # removes an older version; your habits are kept
mv "Habit Calendar.app" /Applications/
xattr -dr com.apple.quarantine "/Applications/Habit Calendar.app"
open "/Applications/Habit Calendar.app"
```

Or by hand: unzip, drag **Habit Calendar** into Applications and open it. The app isn't signed with an Apple Developer ID, so macOS blocks the first launch — go to **System Settings → Privacy & Security** and click **Open Anyway**.

**Windows** — `habit-calendar-windows-amd64.zip`
1. Unzip and run `habit-calendar.exe`.
2. If you see "Windows protected your PC", click **More info → Run anyway** (the app isn't code-signed).

**Linux** — `habit-calendar-linux-amd64.tar.gz` (x86-64, Ubuntu 22.04+ or similar)
1. Install the web view runtime if you don't have it: `sudo apt install libwebkit2gtk-4.1-0`
2. `tar -xzf habit-calendar-linux-amd64.tar.gz && ./habit-calendar`

`SHA256SUMS.txt` lists checksums if you want to verify a download.
