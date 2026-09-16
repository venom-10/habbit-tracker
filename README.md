# Habit Calendar

A small desktop calendar for daily habits. Each day shows one dot per habit, either done, partway to a count target, or missed. Click a day to log it. Habits, yearly view and stats slide over the calendar from the toolbar.

Built with [Wails v2](https://wails.io): a Go backend storing everything in SQLite, and a plain HTML/CSS/JS frontend with no build step.

## Requirements

- Go 1.25+ (the `go` directive will fetch it automatically if you have an older Go)
- Wails CLI: `go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0`
- Platform libraries:

| OS | Install |
|---|---|
| Ubuntu 24.04+ / Debian 13 | `sudo apt install build-essential libgtk-3-dev libwebkit2gtk-4.1-dev` |
| Fedora | `sudo dnf install gtk3-devel webkit2gtk4.1-devel` |
| macOS | Xcode command line tools: `xcode-select --install` |
| Windows | WebView2 runtime (preinstalled on Windows 10/11) |

Run `wails doctor` to check what's missing.

## Develop

```sh
wails dev                    # macOS, Windows
wails dev -tags webkit2_41   # Linux with WebKitGTK 4.1 (Ubuntu 24.04+)
```

Frontend files in `frontend/dist` reload on save.

## Build

```sh
wails build -tags webkit2_41                 # Linux  -> build/bin/habit-calendar
wails build -platform windows/amd64          # Windows, also works from Linux or macOS
wails build -platform darwin/universal       # macOS, must be built on a Mac
```

## Tests

```sh
go test ./...
```

## Where data is stored

A single SQLite file, `habits.db`, in a `habit-calendar` folder under the user config directory:

- Linux: `~/.config/habit-calendar/`
- macOS: `~/Library/Application Support/habit-calendar/`
- Windows: `%AppData%\habit-calendar\`

Copy that file to back up or move your history.

## Layout

```
main.go                 window options, database location
app.go                  methods exposed to the frontend
internal/store/         SQLite schema, validation and queries
frontend/dist/          index.html, style.css, app.js, bundled fonts
```

## Fonts

Bricolage Grotesque, Instrument Sans and JetBrains Mono are bundled under the SIL Open Font License 1.1. The license texts are in `frontend/dist/fonts/`.
