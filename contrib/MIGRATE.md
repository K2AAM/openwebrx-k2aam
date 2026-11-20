# Replacing stock OpenWebRX+ on a remote receiver

For a receiver you cannot reach in person (written for websdrv2, the SDRplay box). It assumes
OpenWebRX+ was installed from the apt package and that you reach the machine over SSH, so a broken
OpenWebRX+ never locks you out. Every step that changes something is covered by an automatic
rollback you arm first.

Do this only after the same package has run on a receiver you can reach (the OptiplexSDR).

## 0. Bring the package

The `openwebrx` package is architecture-independent. Copy the exact `.deb` you built and tested on
the local receiver rather than building again:

```bash
scp openwebrx_*_all.deb websdrv2:~/
```

## 1. Look before changing anything

```bash
ssh websdrv2
tmux new -s owrx                      # survives a dropped SSH session; reattach with: tmux attach -t owrx
dpkg -l openwebrx | tail -1           # must show an installed package; if not, stop: this is not an apt install
apt-cache policy openwebrx | head -3
systemctl is-active openwebrx
P=/usr/lib/python3/dist-packages/htdocs/plugins/receiver
ls $P; cat $P/init.js
ls /var/lib/openwebrx/rsp-antenna-switcher/install.json 2>/dev/null   # present = old antenna patch installed
df -h / | tail -1                     # want a few hundred MB free
```

## 2. Back up

```bash
sudo mkdir -p /root/owrx-rollback && cd /root/owrx-rollback
sudo tar czf data.tgz /var/lib/openwebrx /etc/openwebrx
sudo tar czf plugins.tgz -C /usr/lib/python3/dist-packages/htdocs plugins
sudo cp -a /etc/openwebrx/antenna-switcher.json antenna-switcher.json.keep 2>/dev/null
ls -la
```

`data.tgz` holds settings, profiles, users and bookmarks. `plugins.tgz` holds your current `init.js`
and any plugins you added by hand; installing the fork replaces `init.js`.

## 3. Remove the old antenna patch

Only if step 1 found `install.json`:

```bash
sudo python3 ~/OWRX_RSPdx_Antenna_Switcher/install.py --uninstall
sudo systemctl restart openwebrx && sleep 10 && systemctl is-active openwebrx
```

If the uninstall refuses because a file changed since installation, leave it: the package installs
in the next steps overwrite those files anyway. In that case just move the record aside with
`sudo mv /var/lib/openwebrx/rsp-antenna-switcher /root/owrx-rollback/`.

## 4. Update stock OpenWebRX+ first

This moves the machine to the current upstream release and its matching libraries by the normal,
well-trodden route, and gives a known-good package to fall back to.

```bash
sudo apt update
sudo apt install --only-upgrade openwebrx owrx-connector python3-csdr
sudo systemctl restart openwebrx && sleep 15 && systemctl is-active openwebrx
curl -sI http://localhost:8073/ | head -1        # expect HTTP 200 (use your port if it is not 8073)
sudo journalctl -u openwebrx -n 30 --no-pager
```

Open the receiver in a browser and confirm it plays audio. Then save that package for rollback:

```bash
cd /root/owrx-rollback && sudo apt-get download openwebrx && ls openwebrx_*.deb
```

The installed version must now match the fork's (`dpkg -l openwebrx` against the `.deb` file name).
If upstream has moved ahead of the fork, stop here and update the fork first.

## 5. Arm the automatic rollback

If you lose the connection or the fork misbehaves, this puts the stock package and your old plugins
back in 20 minutes without you:

```bash
sudo systemd-run --unit=owrx-rollback --on-active=20min /bin/sh -c '
  apt-mark unhold openwebrx
  dpkg -i /root/owrx-rollback/openwebrx_*.deb
  tar xzf /root/owrx-rollback/plugins.tgz -C /usr/lib/python3/dist-packages/htdocs
  systemctl restart openwebrx'
systemctl list-timers owrx-rollback.timer --no-pager
```

## 6. Install the fork

```bash
sudo apt install ~/openwebrx_*_all.deb
sudo apt-mark hold openwebrx
[ -f /root/owrx-rollback/antenna-switcher.json.keep ] && sudo cp -a /root/owrx-rollback/antenna-switcher.json.keep /etc/openwebrx/antenna-switcher.json
sudo systemctl restart openwebrx && sleep 15 && systemctl is-active openwebrx
curl -sI http://localhost:8073/ | head -1
ls /usr/lib/python3/dist-packages/htdocs/plugins/receiver/k2aam_dock/   # proves the fork is what is installed
sudo journalctl -u openwebrx -n 40 --no-pager | grep -iE 'error|traceback|antenna|ale' || echo "log clean"
```

The fork and upstream share a version number, so the `k2aam_dock` folder is the reliable sign.

## 7. Check it from a browser

- The page loads with the K2AAM Dock, audio plays, and the waterfall moves.
- Antenna buttons appear in the dock; switch once and confirm reception changes.
- Settings → General still shows your profiles and receiver details.
- More controls → Interface offers K2AAM Dock, RIG skin and Stock; try Stock and switch back.
- If your old `init.js` loaded plugins the fork does not ship, they are still on disk but no longer
  loaded. Re-add their `Plugins.load(...)` lines to the fork's `init.js` in your clone and rebuild,
  or add them on the box knowing the next package install replaces the file.

## 8. Keep it, or go back

Happy with it? Cancel the rollback before the 20 minutes are up:

```bash
sudo systemctl stop owrx-rollback.timer
systemctl list-timers owrx-rollback.timer --no-pager     # should list nothing
```

Not happy? Either wait for the timer, or run the rollback now:

```bash
sudo systemctl start owrx-rollback.service
```

To restore settings as well (normally unnecessary; the package does not touch them):

```bash
sudo systemctl stop openwebrx && sudo tar xzf /root/owrx-rollback/data.tgz -C / && sudo systemctl start openwebrx
```

After a rollback the old antenna patch is not reinstalled; run its `install.py --install` again if
you want it back on stock.

## 9. Afterwards

- Change the magic key if it is still the default `memagic` (Settings → General).
- ALE is off on this box until its decoder is built there. It needs a compiler on the machine:
  `sudo apt install build-essential`, clone the repository, then the "ALE decoder binary" step in
  [DEPLOY.md](DEPLOY.md). Skip this if the receiver is short on CPU.
- Leave `/root/owrx-rollback` in place until the receiver has run for a few days.
