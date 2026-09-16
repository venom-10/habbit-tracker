package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "habits.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	s.now = func() time.Time { return time.Date(2026, 9, 16, 12, 0, 0, 0, time.Local) }
	t.Cleanup(func() { s.Close() })
	return s
}

func mustSave(t *testing.T, s *Store, h Habit) Habit {
	t.Helper()
	saved, err := s.SaveHabit(context.Background(), h)
	if err != nil {
		t.Fatalf("SaveHabit(%+v): %v", h, err)
	}
	return saved
}

func TestSaveAndListHabits(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	water := mustSave(t, s, Habit{Name: "  Water ", Color: "teal", Kind: KindCount, Target: 8, Unit: "glasses"})
	gym := mustSave(t, s, Habit{Name: "Gym", Color: "blue", Kind: KindBool, Target: 5, Unit: "ignored"})
	if water.ID == "" || gym.ID == "" || water.ID == gym.ID {
		t.Fatalf("expected distinct generated ids, got %q and %q", water.ID, gym.ID)
	}
	if water.Name != "Water" {
		t.Errorf("name not trimmed: %q", water.Name)
	}
	if water.CreatedOn != "2026-09-16" {
		t.Errorf("CreatedOn = %q, want the store's today 2026-09-16", water.CreatedOn)
	}
	if gym.Target != 1 || gym.Unit != "" {
		t.Errorf("bool habit should have target 1 and no unit, got %d %q", gym.Target, gym.Unit)
	}

	water.Target = 10
	water.CreatedOn = "1999-01-01" // callers can't rewrite history
	updated, err := s.SaveHabit(ctx, water)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.CreatedOn != "2026-09-16" {
		t.Errorf("update changed CreatedOn to %q", updated.CreatedOn)
	}

	got, err := s.ListHabits(ctx)
	if err != nil {
		t.Fatalf("ListHabits: %v", err)
	}
	if len(got) != 2 || got[0].Name != "Water" || got[1].Name != "Gym" {
		t.Fatalf("unexpected order or contents: %+v", got)
	}
	if got[0].Target != 10 {
		t.Errorf("update not persisted, target = %d", got[0].Target)
	}
}

func TestListHabitsEmptyIsNotNil(t *testing.T) {
	got, err := openTest(t).ListHabits(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("want empty slice so the frontend receives [], got nil")
	}
}

func TestSaveHabitValidation(t *testing.T) {
	s := openTest(t)
	cases := map[string]Habit{
		"blank name":  {Name: "  ", Color: "teal", Kind: KindBool},
		"bad color":   {Name: "Run", Color: "pink", Kind: KindBool},
		"bad kind":    {Name: "Run", Color: "teal", Kind: "maybe"},
		"zero target": {Name: "Run", Color: "teal", Kind: KindCount, Target: 0},
		"long unit":   {Name: "Run", Color: "teal", Kind: KindCount, Target: 3, Unit: "kilometres-and-more"},
		"unknown id":  {ID: "nope", Name: "Run", Color: "teal", Kind: KindBool},
	}
	for name, h := range cases {
		if _, err := s.SaveHabit(context.Background(), h); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if _, err := s.SaveHabit(context.Background(), cases["unknown id"]); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: want ErrNotFound, got %v", err)
	}
}

func TestEntries(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	water := mustSave(t, s, Habit{Name: "Water", Color: "teal", Kind: KindCount, Target: 8, Unit: "glasses"})
	gym := mustSave(t, s, Habit{Name: "Gym", Color: "blue", Kind: KindBool})

	steps := []struct {
		date, id string
		value    int
	}{
		{"2026-09-15", water.ID, 6},
		{"2026-09-15", water.ID, 8}, // overwrite
		{"2026-09-15", gym.ID, 7},   // bool stores 1
		{"2026-09-16", water.ID, 3},
		{"2026-09-16", water.ID, 0}, // clear
	}
	for _, st := range steps {
		if err := s.SetEntry(ctx, st.date, st.id, st.value); err != nil {
			t.Fatalf("SetEntry(%s, %d): %v", st.date, st.value, err)
		}
	}

	r, err := s.GetRange(ctx, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := r.Entries["2026-09-15"][water.ID]; got != 8 {
		t.Errorf("water on 15th = %d, want 8", got)
	}
	if got := r.Entries["2026-09-15"][gym.ID]; got != 1 {
		t.Errorf("gym on 15th = %d, want 1", got)
	}
	if _, ok := r.Entries["2026-09-16"]; ok {
		t.Errorf("16th should be empty after clearing, got %v", r.Entries["2026-09-16"])
	}

	if err := s.SetEntry(ctx, "2026-09-17", water.ID, 1); !errors.Is(err, ErrInvalid) {
		t.Errorf("future date: want ErrInvalid, got %v", err)
	}
	if err := s.SetEntry(ctx, "2026-9-1", water.ID, 1); !errors.Is(err, ErrInvalid) {
		t.Errorf("bad date: want ErrInvalid, got %v", err)
	}
	if err := s.SetEntry(ctx, "2026-09-15", water.ID, -1); !errors.Is(err, ErrInvalid) {
		t.Errorf("negative value: want ErrInvalid, got %v", err)
	}
	if err := s.SetEntry(ctx, "2026-09-15", "missing", 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing habit: want ErrNotFound, got %v", err)
	}
}

func TestNotesAndRange(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	notes := map[string]string{
		"2026-08-31": "end of August",
		"2026-09-01": "first",
		"2026-09-30": "planned day", // future notes are allowed
	}
	for d, body := range notes {
		if err := s.SetNote(ctx, d, body); err != nil {
			t.Fatalf("SetNote(%s): %v", d, err)
		}
	}
	if err := s.SetNote(ctx, "2026-09-01", "   "); err != nil {
		t.Fatalf("clearing note: %v", err)
	}

	r, err := s.GetRange(ctx, "2026-09-01", "2026-09-30")
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Notes) != 1 || r.Notes["2026-09-30"] != "planned day" {
		t.Errorf("unexpected notes in September: %v", r.Notes)
	}
	if _, err := s.GetRange(ctx, "yesterday", ""); !errors.Is(err, ErrInvalid) {
		t.Errorf("bad bound: want ErrInvalid, got %v", err)
	}
}

func TestSettings(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if v, err := s.Setting(ctx, "theme"); err != nil || v != "" {
		t.Fatalf("unset setting = %q, %v", v, err)
	}
	for _, v := range []string{"dark", "light"} {
		if err := s.SetSetting(ctx, "theme", v); err != nil {
			t.Fatal(err)
		}
	}
	if v, _ := s.Setting(ctx, "theme"); v != "light" {
		t.Errorf("theme = %q, want light", v)
	}
}

func TestReopenKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "habits.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveHabit(context.Background(), Habit{Name: "Read", Color: "amber", Kind: KindCount, Target: 30, Unit: "min"}); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s.Close()
	got, err := s.ListHabits(context.Background())
	if err != nil || len(got) != 1 {
		t.Fatalf("after reopen: %+v, %v", got, err)
	}
}
