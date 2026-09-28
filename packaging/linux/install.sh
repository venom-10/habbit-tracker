#!/bin/sh
# Installs Habit Calendar for the current user: the binary, its icons and a
# launcher entry. No root needed. Run it again to update an existing install.
set -eu

app=habit-calendar
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data=${XDG_DATA_HOME:-$HOME/.local/share}
bin_dir=$HOME/.local/bin
icon_dir=$data/icons/hicolor
apps_dir=$data/applications

mkdir -p "$bin_dir" "$icon_dir/512x512/apps" "$icon_dir/scalable/apps" "$apps_dir"
install -m 755 "$here/$app" "$bin_dir/$app"
install -m 644 "$here/appicon.png" "$icon_dir/512x512/apps/$app.png"
install -m 644 "$here/appicon.svg" "$icon_dir/scalable/apps/$app.svg"

# StartupWMClass ties the running window to this entry, so the dock shows the
# app's own icon and name instead of a generic one.
cat > "$apps_dir/$app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Habit Calendar
Comment=A compact calendar for tracking daily habits
Exec=$bin_dir/$app
Icon=$app
Terminal=false
Categories=Utility;
StartupWMClass=$app
EOF
chmod 644 "$apps_dir/$app.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database "$apps_dir" || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -f -t "$icon_dir" >/dev/null 2>&1 || true
fi

echo "Installed. Look for \"Habit Calendar\" in your applications."
echo "Command line: $bin_dir/$app"
case ":$PATH:" in
*":$bin_dir:"*) ;;
*) echo "Note: $bin_dir is not on your PATH, so the command above needs its full path." ;;
esac
echo "Your habits are stored in ${XDG_CONFIG_HOME:-$HOME/.config}/habit-calendar/habits.db"
