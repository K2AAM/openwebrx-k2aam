#!/usr/bin/env bash
# Replace an apt-installed OpenWebRX+ with this fork, with backups and a timed rollback.
#
#   sudo contrib/migrate.sh check              read-only look at the machine
#   sudo contrib/migrate.sh install            back up, build, install, start the rollback timer
#   sudo contrib/migrate.sh confirm            keep the fork (cancels the rollback timer)
#   sudo contrib/migrate.sh rollback           go back to stock now
#   sudo contrib/migrate.sh rollback --with-data   ...and also restore settings and profiles
#   sudo contrib/migrate.sh status
#
# Run it from a clone of the fork; "install" builds whatever commit is checked out.
# Options for install:  --no-ale   skip the ALE decoder     --minutes N   rollback delay (default 30)
#
# Settings, profiles, users and bookmarks live in /var/lib/openwebrx and are not touched by the
# package; they are backed up anyway and only restored if you ask for it.
set -euo pipefail

BACKUP=${OWRX_BACKUP_DIR:-/root/owrx-rollback}
DATA=${OWRX_DATA_DIR:-/var/lib/openwebrx}
ETC=${OWRX_ETC_DIR:-/etc/openwebrx}
PYLIB=${OWRX_PYLIB_DIR:-/usr/lib/python3/dist-packages}
ALE_BIN=${OWRX_ALE_BIN:-/usr/local/bin/owrx-ale}
UNIT=owrx-rollback
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HTDOCS=$PYLIB/htdocs
PLUGINS=$HTDOCS/plugins

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
# sudo runs git as root in a clone owned by the user; tell git that is intended.
g()    { git -c safe.directory="$REPO" -C "$REPO" "$@"; }

need_root() { [ "$(id -u)" = 0 ] || die "run with sudo"; }

installed_version() { dpkg-query -W -f='${Version}' openwebrx 2>/dev/null || true; }

web_port() {
    local port
    port=$(sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ETC/openwebrx.conf" 2>/dev/null | head -1)
    echo "${port:-8073}"
}

# Wait for the web server to answer; OpenWebRX+ can take a while to start its SDRs.
healthy() {
    local port tries=${1:-45}
    port=$(web_port)
    for _ in $(seq 1 "$tries"); do
        if systemctl is-active --quiet openwebrx && python3 - "$port" <<'PY' 2>/dev/null
import ssl, sys, urllib.request
for scheme in ("http", "https"):
    try:
        context = ssl._create_unverified_context() if scheme == "https" else None
        with urllib.request.urlopen(f"{scheme}://127.0.0.1:{sys.argv[1]}/", timeout=5, context=context) as reply:
            if reply.status == 200:
                sys.exit(0)
    except Exception:
        pass
sys.exit(1)
PY
        then return 0; fi
        sleep 2
    done
    return 1
}

timer_active() { systemctl is-active --quiet "$UNIT.timer" 2>/dev/null; }

cancel_timer() {
    systemctl stop "$UNIT.timer" 2>/dev/null || true
    systemctl reset-failed "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
}

cmd_check() {
    say "OpenWebRX+ on this machine"
    local version; version=$(installed_version)
    [ -n "$version" ] || die "openwebrx is not installed from a package here; this script does not apply"
    note "installed package: openwebrx $version"
    note "service: $(systemctl is-active openwebrx 2>/dev/null || true)   web port: $(web_port)"
    note "fork checkout: $(g rev-parse --short HEAD 2>/dev/null || echo unknown) on $(g rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown), version $(sed -n 's/^_versionstring = "\(.*\)"/\1/p' "$REPO/owrx/version.py" 2>/dev/null)"
    if [ -d "$PLUGINS/receiver/k2aam_dock" ]; then note "the fork is ALREADY installed (k2aam_dock plugin present)"; fi
    if [ -f "$PLUGINS/receiver/init.js" ]; then
        note "current receiver init.js loads:"
        grep -E '^[[:space:]]*(await[[:space:]]+)?Plugins\.load' "$PLUGINS/receiver/init.js" | sed 's/^/        /' || note "        (nothing)"
    fi
    local leftover
    for leftover in rsp-antenna-switcher rig-dock ale2g; do
        [ -e "$DATA/$leftover" ] && note "old patch-installer record: $DATA/$leftover (install will archive it)"
    done
    [ -f "$ETC/antenna-switcher.json" ] && note "antenna switcher config: $ETC/antenna-switcher.json (kept)"
    note "free space on /: $(df -h / | awk 'NR==2 {print $4}')"
    if timer_active; then note "a rollback timer is RUNNING: $(systemctl list-timers "$UNIT.timer" --no-pager 2>/dev/null | sed -n 2p)"; fi
    [ -d "$BACKUP" ] && note "existing backup directory: $BACKUP"
    return 0
}

cmd_status() {
    cmd_check
    say "Rollback"
    if timer_active; then note "timer armed; 'confirm' cancels it, 'rollback' runs it now"
    elif ls "$BACKUP"/stock/openwebrx_*.deb >/dev/null 2>&1; then note "no timer running; 'rollback' is still available from $BACKUP"
    else note "no backup found"; fi
}

backup() {
    say "Backing up to $BACKUP"
    mkdir -p "$BACKUP/stock"
    chmod 700 "$BACKUP"
    if [ -f "$BACKUP/data.tgz" ] && [ ! -d "$PLUGINS/receiver/k2aam_dock" ]; then
        # A second attempt from stock: keep the first backup too.
        mv "$BACKUP/data.tgz" "$BACKUP/data.$(date +%Y%m%d-%H%M%S).tgz"
    fi
    if [ ! -d "$PLUGINS/receiver/k2aam_dock" ]; then
        tar czf "$BACKUP/data.tgz" -C / "${DATA#/}" "${ETC#/}"
        if [ -d "$PLUGINS" ]; then tar czf "$BACKUP/plugins.tgz" -C "$HTDOCS" plugins; fi
        note "settings, profiles, users, bookmarks: data.tgz ($(du -h "$BACKUP/data.tgz" | cut -f1))"
        note "plugins and init.js: plugins.tgz"
    else
        [ -f "$BACKUP/data.tgz" ] || die "the fork is already installed and there is no earlier backup in $BACKUP; refusing to treat the fork as the rollback target"
        note "fork already installed: keeping the existing stock backup"
    fi
    cp -a "${BASH_SOURCE[0]}" "$BACKUP/migrate.sh"
}

save_stock_package() {
    say "Saving the stock package for rollback"
    if [ -d "$PLUGINS/receiver/k2aam_dock" ]; then
        ls "$BACKUP"/stock/openwebrx_*.deb >/dev/null 2>&1 || die "no saved stock package in $BACKUP/stock"
        note "keeping $(basename "$(ls "$BACKUP"/stock/openwebrx_*.deb | head -1)")"
        return
    fi
    rm -f "$BACKUP"/stock/openwebrx_*.deb
    ( cd "$BACKUP/stock" && apt-get download openwebrx >/dev/null ) || die "could not download the installed stock package; without it there is no rollback"
    local deb; deb=$(ls "$BACKUP"/stock/openwebrx_*.deb | head -1)
    [ "$(dpkg-deb -f "$deb" Version)" = "$(installed_version)" ] || die "the repository's openwebrx ($(dpkg-deb -f "$deb" Version)) is not the installed one ($(installed_version)); run 'sudo apt install --only-upgrade openwebrx', check the receiver, then try again"
    note "$(basename "$deb")"
}

archive_old_patch_records() {
    # Records left by the earlier patch installers describe files from an older release.
    # Their uninstallers must never run against this install, so move the records away.
    local leftover found=0
    for leftover in rsp-antenna-switcher rig-dock ale2g; do
        if [ -e "$DATA/$leftover" ]; then
            [ $found = 0 ] && say "Archiving old patch-installer records"
            found=1
            mkdir -p "$BACKUP/old-patch-records"
            rm -rf "$BACKUP/old-patch-records/$leftover"
            mv "$DATA/$leftover" "$BACKUP/old-patch-records/$leftover"
            note "$leftover -> $BACKUP/old-patch-records/"
        fi
    done
    if [ -f "$ETC/antenna-switcher.json" ]; then cp -a "$ETC/antenna-switcher.json" "$BACKUP/antenna-switcher.json.keep"; fi
}

build() {
    local with_ale=$1
    say "Installing build tools"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        git build-essential debhelper dh-python python3-all python3-setuptools >/dev/null
    say "Building the fork package from $(g rev-parse --short HEAD)"
    [ -z "$(g status --porcelain --untracked-files=no)" ] || note "note: uncommitted changes in the clone are NOT included; the committed state is built"
    rm -rf "$BACKUP/build"
    mkdir -p "$BACKUP/build/src"
    g archive HEAD | tar -x -C "$BACKUP/build/src"
    g rev-parse HEAD > "$BACKUP/build/commit"
    ( cd "$BACKUP/build/src" && dpkg-buildpackage -us -uc -b >"$BACKUP/build/package.log" 2>&1 ) \
        || { tail -20 "$BACKUP/build/package.log"; die "package build failed; nothing on the receiver was changed (log: $BACKUP/build/package.log)"; }
    FORK_DEB=$(ls "$BACKUP"/build/openwebrx_*_all.deb | head -1)
    note "$(basename "$FORK_DEB")"
    dpkg-deb -c "$FORK_DEB" | grep -q 'htdocs/plugins/receiver/k2aam_dock/k2aam_dock.js' || die "the built package does not contain the dock plugin"
    dpkg-deb -c "$FORK_DEB" | grep -q 'owrx/ale_channels.json' || die "the built package does not contain the ALE channel list"
    if [ "$with_ale" = 1 ]; then
        say "Building the ALE decoder"
        make -C "$BACKUP/build/src/contrib/ale/decoder" >"$BACKUP/build/ale.log" 2>&1 \
            || { tail -20 "$BACKUP/build/ale.log"; die "ALE decoder build failed; nothing on the receiver was changed. Use --no-ale to go on without it"; }
        "$BACKUP/build/src/contrib/ale/decoder/owrx-ale" --version | sed 's/^/    /'
    fi
}

arm_rollback() {
    local minutes=$1
    say "Starting the $minutes-minute rollback timer"
    cancel_timer
    systemd-run --quiet --unit="$UNIT" --on-active="${minutes}min" --description="Roll OpenWebRX+ back to stock" \
        /bin/bash "$BACKUP/migrate.sh" rollback --auto
    note "if you do nothing, stock OpenWebRX+ comes back at $(date -d "+$minutes minutes" '+%H:%M %Z')"
}

cmd_install() {
    need_root
    local with_ale=1 minutes=30
    while [ $# -gt 0 ]; do
        case $1 in
            --no-ale) with_ale=0 ;;
            --minutes) shift; minutes=${1:-}; [[ $minutes =~ ^[0-9]+$ ]] && [ "$minutes" -ge 5 ] && [ "$minutes" -le 240 ] || die "--minutes needs a number from 5 to 240" ;;
            *) die "unknown option: $1" ;;
        esac
        shift
    done
    cmd_check
    local stock fork
    stock=$(installed_version)
    fork=$(sed -n 's/^_versionstring = "\(.*\)"/\1/p' "$REPO/owrx/version.py")
    if [ ! -d "$PLUGINS/receiver/k2aam_dock" ] && [ "$stock" != "$fork" ]; then
        die "stock OpenWebRX+ here is $stock but the fork is $fork. Bring them to the same release first (apt upgrade here, or merge upstream into the fork), so the supporting libraries match"
    fi
    systemctl is-active --quiet openwebrx || die "openwebrx is not running now; fix that before changing anything"
    healthy 5 || die "openwebrx is running but its web page does not answer on port $(web_port); fix that first"

    backup
    save_stock_package
    build "$with_ale"          # everything up to here leaves the running receiver untouched
    archive_old_patch_records
    arm_rollback "$minutes"

    say "Installing the fork"
    apt-mark unhold openwebrx >/dev/null 2>&1 || true
    # dpkg, not apt: the fork has the same version number as stock, and its
    # dependencies are already satisfied by the stock install it replaces.
    dpkg -i "$FORK_DEB" >"$BACKUP/build/install.log" 2>&1 \
        || { tail -20 "$BACKUP/build/install.log"; say "Install failed; rolling back now"; cmd_rollback; exit 1; }
    apt-mark hold openwebrx >/dev/null
    [ -d "$PLUGINS/receiver/k2aam_dock" ] || { say "The dock plugin is missing after install; rolling back now"; cmd_rollback; exit 1; }
    if [ "$with_ale" = 1 ]; then install -m 755 "$BACKUP/build/src/contrib/ale/decoder/owrx-ale" "$ALE_BIN"; note "ALE decoder: $ALE_BIN"; fi
    if [ -f "$BACKUP/antenna-switcher.json.keep" ] && [ ! -f "$ETC/antenna-switcher.json" ]; then
        cp -a "$BACKUP/antenna-switcher.json.keep" "$ETC/antenna-switcher.json"; note "antenna switcher config restored"
    fi

    say "Restarting OpenWebRX+"
    systemctl restart openwebrx
    if ! healthy ${OWRX_HEALTH_TRIES:-60}; then
        journalctl -u openwebrx -n 25 --no-pager 2>/dev/null | sed 's/^/    /' || true
        say "The fork did not come up; rolling back now"
        cmd_rollback
        exit 1
    fi
    note "web page answers on port $(web_port)"
    if journalctl -u openwebrx --since "-2min" --no-pager 2>/dev/null | grep -q Traceback; then
        note "WARNING: the service log shows a Python traceback since the restart:"
        journalctl -u openwebrx --since "-2min" --no-pager | grep -A6 Traceback | head -20 | sed 's/^/        /'
    fi
    if [ -f "$BACKUP/plugins.tgz" ]; then
        local old
        old=$(tar xzOf "$BACKUP/plugins.tgz" plugins/receiver/init.js 2>/dev/null | grep -E '^[[:space:]]*(await[[:space:]]+)?Plugins\.load' | grep -vE "rsp_antenna|rig_skin|rig_dock|audio_filter|mode_selector" || true)
        if [ -n "$old" ]; then
            note "your old init.js also loaded these, which the fork's init.js does not:"
            printf '%s\n' "$old" | sed 's/^/        /'
        fi
    fi

    cat <<EOF

==> Installed. Now check it in a browser:
      - page loads with the K2AAM Dock, audio plays, waterfall moves
      - antenna buttons work
      - your profiles are all there
    Then, within $minutes minutes:
      keep it:   sudo $BACKUP/migrate.sh confirm
      go back:   sudo $BACKUP/migrate.sh rollback
    Doing nothing rolls back automatically.
EOF
}

cmd_confirm() {
    need_root
    [ -d "$PLUGINS/receiver/k2aam_dock" ] || die "the fork is not installed"
    cancel_timer
    say "Rollback timer cancelled; the fork stays"
    note "the backup remains in $BACKUP; 'rollback' still works until you delete it"
    note "change the magic key if it is still the default (Settings -> General)"
}

cmd_rollback() {
    need_root
    local with_data=0 auto=0
    for arg in "$@"; do
        case $arg in --with-data) with_data=1 ;; --auto) auto=1 ;; *) die "unknown option: $arg" ;; esac
    done
    local deb; deb=$(ls "$BACKUP"/stock/openwebrx_*.deb 2>/dev/null | head -1 || true)
    [ -n "$deb" ] || die "no saved stock package in $BACKUP/stock"
    say "Rolling back to stock ($(basename "$deb"))"
    apt-mark unhold openwebrx >/dev/null 2>&1 || true
    systemctl stop openwebrx || true
    dpkg -i "$deb" >"$BACKUP/rollback.log" 2>&1 || { tail -20 "$BACKUP/rollback.log"; die "could not reinstall the stock package (log: $BACKUP/rollback.log)"; }
    if [ -f "$BACKUP/plugins.tgz" ]; then
        rm -rf "$PLUGINS"
        tar xzf "$BACKUP/plugins.tgz" -C "$HTDOCS"
        note "plugins and init.js restored"
    fi
    if [ $with_data = 1 ]; then
        tar xzf "$BACKUP/data.tgz" -C /
        note "settings, profiles, users and bookmarks restored from the backup"
    fi
    systemctl start openwebrx
    # The timer has already fired when it starts this; only a manual rollback needs to cancel it.
    [ $auto = 1 ] || cancel_timer
    if healthy ${OWRX_HEALTH_TRIES:-60}; then note "stock OpenWebRX+ $(installed_version) is answering on port $(web_port)"
    else note "WARNING: OpenWebRX+ is not answering yet; check 'journalctl -u openwebrx -n 50'"; fi
    note "the old antenna patch is not reinstalled on stock"
}

case ${1:-} in
    check)    cmd_check ;;
    status)   cmd_status ;;
    install)  shift; cmd_install "$@" ;;
    confirm)  cmd_confirm ;;
    rollback) shift; cmd_rollback "$@" ;;
    *) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
