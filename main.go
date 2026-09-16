package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"

	"habbit-tracker/internal/store"
)

//go:embed all:frontend/dist
var assets embed.FS

// The window is sized to the compact calendar: a toolbar plus a six-week grid.
const (
	windowWidth  = 480
	windowHeight = 420
)

func main() {
	path, err := databasePath()
	if err != nil {
		log.Fatal(err)
	}
	s, err := store.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	app := NewApp(s)

	err = wails.Run(&options.App{
		Title:            "Habit Calendar",
		Width:            windowWidth,
		Height:           windowHeight,
		MinWidth:         340,
		MinHeight:        340,
		MaxWidth:         560,
		MaxHeight:        560,
		BackgroundColour: backgroundFor(s),
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		Linux:            &linux.Options{ProgramName: "habit-calendar"},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// databasePath returns the per-user data file: ~/.config/habit-calendar on
// Linux, ~/Library/Application Support/habit-calendar on macOS and
// %AppData%\habit-calendar on Windows.
func databasePath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find config directory: %w", err)
	}
	dir := filepath.Join(base, "habit-calendar")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create data directory: %w", err)
	}
	return filepath.Join(dir, "habits.db"), nil
}

// backgroundFor paints the window in the saved theme's band colour so it
// doesn't flash a different colour before the page loads.
func backgroundFor(s *store.Store) *options.RGBA {
	if theme, _ := s.Setting(context.Background(), "theme"); theme == "dark" {
		return &options.RGBA{R: 0x14, G: 0x3B, B: 0x2E, A: 255}
	}
	return &options.RGBA{R: 0x1A, G: 0x40, B: 0x33, A: 255}
}
