package main

import (
	"context"
	"fmt"

	"habbit-tracker/internal/store"
)

// App is bound to the frontend; each exported method becomes
// window.go.main.App.<Method> returning a promise.
type App struct {
	ctx   context.Context
	store *store.Store
}

func NewApp(s *store.Store) *App {
	return &App{ctx: context.Background(), store: s}
}

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

func (a *App) shutdown(context.Context) { a.store.Close() }

func (a *App) ListHabits() ([]store.Habit, error) {
	return a.store.ListHabits(a.ctx)
}

// SaveHabit creates the habit when it has no id, otherwise updates it,
// and returns the stored version.
func (a *App) SaveHabit(h store.Habit) (store.Habit, error) {
	return a.store.SaveHabit(a.ctx, h)
}

// DeleteHabit removes a habit along with all of its logged days.
func (a *App) DeleteHabit(id string) error {
	return a.store.DeleteHabit(a.ctx, id)
}

// SetEntry sets a habit's value for a YYYY-MM-DD date; 0 clears it.
func (a *App) SetEntry(date, habitID string, value int) error {
	return a.store.SetEntry(a.ctx, date, habitID, value)
}

// SetNote saves the note for a YYYY-MM-DD date; blank text removes it.
func (a *App) SetNote(date, body string) error {
	return a.store.SetNote(a.ctx, date, body)
}

// GetRange returns entries and notes between two dates, inclusive.
// Pass empty strings for an open-ended range.
func (a *App) GetRange(from, to string) (store.Range, error) {
	return a.store.GetRange(a.ctx, from, to)
}

// Theme returns "light", "dark", or "" when following the system.
func (a *App) Theme() (string, error) {
	return a.store.Setting(a.ctx, "theme")
}

func (a *App) SetTheme(theme string) error {
	if theme != "" && theme != "light" && theme != "dark" {
		return fmt.Errorf("%w: theme must be light, dark or empty", store.ErrInvalid)
	}
	return a.store.SetSetting(a.ctx, "theme", theme)
}
