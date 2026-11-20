# Deploying this fork on a fresh receiver

This fork is installed as its own `openwebrx` package. The receiver plugins it ships (dock, RIG
skin, interface chooser, ALE) are enabled in `htdocs/plugins/receiver/init.js`; see
[plugins](PLUGINS.md).

## 1. Stock dependencies

Set up the OpenWebRX+ package repository and install stock `openwebrx` once, following the upstream
installation instructions. This pulls in the connectors, `python3-csdr` and the decoder packages
that this fork depends on but does not build.

## 2. Build and install the fork

```bash
sudo apt install git build-essential debhelper dh-python python3-all python3-setuptools
git clone --branch ale-scanlists https://github.com/K2AAM/openwebrx-k2aam.git
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

Set a magic key in the receiver settings. Without one, any visitor can start or stop the server
ALE scanner, which holds the SDR while it runs.
