#!/bin/sh
# Removes what install.sh added. Your habits are kept; the last line says how
# to delete them too.
set -eu

app=habit-calendar
data=${XDG_DATA_HOME:-$HOME/.local/share}
db_dir=${XDG_CONFIG_HOME:-$HOME/.config}/habit-calendar

rm -f "$HOME/.local/bin/$app" \
	"$data/icons/hicolor/512x512/apps/$app.png" \
	"$data/icons/hicolor/scalable/apps/$app.svg" \
	"$data/applications/$app.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database "$data/applications" || true
fi

echo "Removed Habit Calendar."
echo "Your habits are still in $db_dir"
echo "To delete them as well: rm -rf \"$db_dir\""
