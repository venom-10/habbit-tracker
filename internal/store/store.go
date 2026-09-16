// Package store keeps habits, daily entries and notes in a local SQLite file.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// DateLayout is the format of every date key: YYYY-MM-DD in local time.
const DateLayout = "2006-01-02"

const (
	KindBool  = "bool"
	KindCount = "count"

	maxNameLen  = 40
	maxUnitLen  = 16
	maxTarget   = 100000
	maxValue    = 1000000
	maxNoteLen  = 10000
	schemaLevel = 1
)

var (
	ErrInvalid  = errors.New("invalid input")
	ErrNotFound = errors.New("not found")
)

// Colors are the palette keys the frontend maps to theme-aware CSS tokens.
var Colors = []string{"teal", "amber", "blue", "coral", "magenta", "moss"}

// Habit is something tracked once a day, either done/not done or counted
// toward a daily target.
type Habit struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Color  string `json:"color"`
	Kind   string `json:"kind"`
	Target int    `json:"target"`
	Unit   string `json:"unit"`
	// CreatedOn is the local date the habit was added. Days before it don't
	// count as missed; the store sets it and ignores values sent by callers.
	CreatedOn string `json:"createdOn"`
}

// Range holds entries (date -> habit id -> value) and notes (date -> text).
type Range struct {
	Entries map[string]map[string]int `json:"entries"`
	Notes   map[string]string         `json:"notes"`
}

type Store struct {
	db  *sql.DB
	now func() time.Time
}

// Open opens (creating if needed) the database at path and applies the schema.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, now: time.Now}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

const schema = `
CREATE TABLE IF NOT EXISTS habits (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	color      TEXT NOT NULL,
	kind       TEXT NOT NULL CHECK (kind IN ('bool', 'count')),
	target     INTEGER NOT NULL CHECK (target >= 1),
	unit       TEXT NOT NULL DEFAULT '',
	position   INTEGER NOT NULL,
	created_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
	date     TEXT NOT NULL,
	habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
	value    INTEGER NOT NULL CHECK (value > 0),
	PRIMARY KEY (date, habit_id)
);
CREATE TABLE IF NOT EXISTS notes (
	date TEXT PRIMARY KEY,
	body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);`

func (s *Store) migrate(ctx context.Context) error {
	var level int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&level); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if level >= schemaLevel {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", schemaLevel)); err != nil {
		return fmt.Errorf("set schema version: %w", err)
	}
	return nil
}

// ListHabits returns all habits in the order they were added.
func (s *Store) ListHabits(ctx context.Context) ([]Habit, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, name, color, kind, target, unit, created_on FROM habits ORDER BY position")
	if err != nil {
		return nil, fmt.Errorf("list habits: %w", err)
	}
	defer rows.Close()
	habits := []Habit{}
	for rows.Next() {
		var h Habit
		if err := rows.Scan(&h.ID, &h.Name, &h.Color, &h.Kind, &h.Target, &h.Unit, &h.CreatedOn); err != nil {
			return nil, fmt.Errorf("list habits: %w", err)
		}
		habits = append(habits, h)
	}
	return habits, rows.Err()
}

// SaveHabit creates the habit when ID is empty, otherwise updates it.
func (s *Store) SaveHabit(ctx context.Context, h Habit) (Habit, error) {
	h, err := normalizeHabit(h)
	if err != nil {
		return Habit{}, err
	}
	if h.ID == "" {
		if h.ID, err = newID(); err != nil {
			return Habit{}, err
		}
		h.CreatedOn = s.now().Format(DateLayout)
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO habits (id, name, color, kind, target, unit, position, created_on)
			VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM habits), ?)`,
			h.ID, h.Name, h.Color, h.Kind, h.Target, h.Unit, h.CreatedOn)
		if err != nil {
			return Habit{}, fmt.Errorf("create habit: %w", err)
		}
		return h, nil
	}
	err = s.db.QueryRowContext(ctx, "UPDATE habits SET name = ?, color = ?, kind = ?, target = ?, unit = ? WHERE id = ? RETURNING created_on",
		h.Name, h.Color, h.Kind, h.Target, h.Unit, h.ID).Scan(&h.CreatedOn)
	if errors.Is(err, sql.ErrNoRows) {
		return Habit{}, fmt.Errorf("update habit %q: %w", h.ID, ErrNotFound)
	}
	if err != nil {
		return Habit{}, fmt.Errorf("update habit: %w", err)
	}
	return h, nil
}

func normalizeHabit(h Habit) (Habit, error) {
	h.Name = strings.TrimSpace(h.Name)
	h.Unit = strings.TrimSpace(h.Unit)
	if n := utf8.RuneCountInString(h.Name); n == 0 || n > maxNameLen {
		return h, fmt.Errorf("%w: name must be 1-%d characters", ErrInvalid, maxNameLen)
	}
	if !validColor(h.Color) {
		return h, fmt.Errorf("%w: unknown color %q", ErrInvalid, h.Color)
	}
	switch h.Kind {
	case KindBool:
		h.Target, h.Unit = 1, ""
	case KindCount:
		if h.Target < 1 || h.Target > maxTarget {
			return h, fmt.Errorf("%w: target must be 1-%d", ErrInvalid, maxTarget)
		}
		if utf8.RuneCountInString(h.Unit) > maxUnitLen {
			return h, fmt.Errorf("%w: unit must be at most %d characters", ErrInvalid, maxUnitLen)
		}
	default:
		return h, fmt.Errorf("%w: kind must be %q or %q", ErrInvalid, KindBool, KindCount)
	}
	return h, nil
}

func validColor(c string) bool {
	for _, known := range Colors {
		if c == known {
			return true
		}
	}
	return false
}

// SetEntry records a habit's value for a day. Zero clears the day; yes/no
// habits store any positive value as 1. Future days are rejected.
func (s *Store) SetEntry(ctx context.Context, date, habitID string, value int) error {
	if err := s.checkDate(date, false); err != nil {
		return err
	}
	if value < 0 || value > maxValue {
		return fmt.Errorf("%w: value must be 0-%d", ErrInvalid, maxValue)
	}
	var kind string
	err := s.db.QueryRowContext(ctx, "SELECT kind FROM habits WHERE id = ?", habitID).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("habit %q: %w", habitID, ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("set entry: %w", err)
	}
	if value == 0 {
		_, err = s.db.ExecContext(ctx, "DELETE FROM entries WHERE date = ? AND habit_id = ?", date, habitID)
	} else {
		if kind == KindBool {
			value = 1
		}
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO entries (date, habit_id, value) VALUES (?, ?, ?)
			ON CONFLICT (date, habit_id) DO UPDATE SET value = excluded.value`, date, habitID, value)
	}
	if err != nil {
		return fmt.Errorf("set entry: %w", err)
	}
	return nil
}

// SetNote stores the note for a day; a blank body removes it.
func (s *Store) SetNote(ctx context.Context, date, body string) error {
	if err := s.checkDate(date, true); err != nil {
		return err
	}
	if utf8.RuneCountInString(body) > maxNoteLen {
		return fmt.Errorf("%w: note must be at most %d characters", ErrInvalid, maxNoteLen)
	}
	var err error
	if strings.TrimSpace(body) == "" {
		_, err = s.db.ExecContext(ctx, "DELETE FROM notes WHERE date = ?", date)
	} else {
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO notes (date, body) VALUES (?, ?)
			ON CONFLICT (date) DO UPDATE SET body = excluded.body`, date, body)
	}
	if err != nil {
		return fmt.Errorf("set note: %w", err)
	}
	return nil
}

// GetRange returns entries and notes between from and to, inclusive.
// An empty bound is open-ended.
func (s *Store) GetRange(ctx context.Context, from, to string) (Range, error) {
	for _, d := range []string{from, to} {
		if d == "" {
			continue
		}
		if _, err := time.Parse(DateLayout, d); err != nil {
			return Range{}, fmt.Errorf("%w: date %q is not YYYY-MM-DD", ErrInvalid, d)
		}
	}
	out := Range{Entries: map[string]map[string]int{}, Notes: map[string]string{}}
	const where = "WHERE (?1 = '' OR date >= ?1) AND (?2 = '' OR date <= ?2)"

	rows, err := s.db.QueryContext(ctx, "SELECT date, habit_id, value FROM entries "+where, from, to)
	if err != nil {
		return Range{}, fmt.Errorf("get entries: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var date, habitID string
		var value int
		if err := rows.Scan(&date, &habitID, &value); err != nil {
			return Range{}, fmt.Errorf("get entries: %w", err)
		}
		if out.Entries[date] == nil {
			out.Entries[date] = map[string]int{}
		}
		out.Entries[date][habitID] = value
	}
	if err := rows.Err(); err != nil {
		return Range{}, fmt.Errorf("get entries: %w", err)
	}

	noteRows, err := s.db.QueryContext(ctx, "SELECT date, body FROM notes "+where, from, to)
	if err != nil {
		return Range{}, fmt.Errorf("get notes: %w", err)
	}
	defer noteRows.Close()
	for noteRows.Next() {
		var date, body string
		if err := noteRows.Scan(&date, &body); err != nil {
			return Range{}, fmt.Errorf("get notes: %w", err)
		}
		out.Notes[date] = body
	}
	if err := noteRows.Err(); err != nil {
		return Range{}, fmt.Errorf("get notes: %w", err)
	}
	return out, nil
}

// Setting returns a stored preference, or "" when it has never been set.
func (s *Store) Setting(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read setting %q: %w", key, err)
	}
	return v, nil
}

func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	if err != nil {
		return fmt.Errorf("save setting %q: %w", key, err)
	}
	return nil
}

func (s *Store) checkDate(date string, allowFuture bool) error {
	if _, err := time.Parse(DateLayout, date); err != nil {
		return fmt.Errorf("%w: date %q is not YYYY-MM-DD", ErrInvalid, date)
	}
	if !allowFuture && date > s.now().Format(DateLayout) {
		return fmt.Errorf("%w: %s is in the future", ErrInvalid, date)
	}
	return nil
}

func newID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
