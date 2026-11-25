# Deploying this fork on a fresh receiver

This fork is installed as its own `openwebrx` package. The receiver plugins it ships (dock, RIG
skin, interface chooser, ALE) are enabled in `htdocs/plugins/receiver/init.js`; see
[plugins](PLUGINS.md).

To replace stock OpenWebRX+ on a receiver you cannot reach in person, follow
[MIGRATE.md](MIGRATE.md) instead; it adds backups and an automatic rollback.

## 1. Stock dependencies

Set up the OpenWebRX+ package repository and install stock `openwebrx` once, following the upstream
installation instructions. This pulls in the connectors, `python3-csdr` and the decoder packages
that this fork depends on but does not build.

## 2. Build and install the fork

```bash
sudo apt install git build-essential debhelper dh-python python3-all python3-setuptools
git clone https://github.com/K2AAM/openwebrx-k2aam.git
cd openwebrx-k2aam
dpkg-buildpackage -us -uc -b
sudo apt install ../openwebrx_*_all.deb
sudo apt-mark hold openwebrx
```

The hold stops `apt upgrade` from replacing the fork with the next upstream release. Settings,
profiles and bookmarks in `/var/lib/openwebrx` are left alone. The package installs its own
`plugins/receiver/init.js`, so keep station edits to that file in your clone and rebuild.

## 3. ALE decoder binary

The package is architecture-independent, so the decoder is built and installed separately:

```bash
make -C contrib/ale/decoder
sudo install -m 755 contrib/ale/decoder/owrx-ale /usr/local/bin/owrx-ale
sudo systemctl restart openwebrx
```

"ALE 2G (experimental)" appears in the mode list once `owrx-ale --version` runs for the
`openwebrx` user. The feature report under Settings shows `owrx_ale` when it is found.

## Updating

```bash
cd openwebrx-k2aam && git pull --ff-only
dpkg-buildpackage -us -uc -b
sudo apt install --allow-change-held-packages ../openwebrx_*_all.deb
sudo systemctl restart openwebrx
```

Rebuild `owrx-ale` only when `contrib/ale/decoder` changes.

## Before exposing the receiver publicly

Change the magic key in Settings → General. OpenWebRX+ ships with the well-known default
`memagic`, which protects nothing. Starting or stopping the server ALE scanner needs that key
(open the receiver as `https://your.receiver/#key=yourkey`), because a scan holds the SDR for
everyone. With an empty key, scanner control is locked rather than open. To let any visitor run
the scanner, tick "Allow anyone to start and stop the ALE scanner" on the same page.
