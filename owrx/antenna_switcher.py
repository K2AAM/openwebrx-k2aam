"""Shared RSPdx/RSPdx-R2 antenna control for OpenWebRX+.

The selected antenna is an in-memory source property overlay. Configured
profiles and settings.json are never written by this module. The connector
does not acknowledge hardware changes; state is the OWRX selection only.

Nothing is switchable until CONFIG_PATH exists and lists a device; without
it every request is answered "not supported". See contrib/antenna/README.md.
"""

import json
import logging
import threading
import time
from pathlib import Path

from owrx.property import PropertyLayer

CONFIG_PATH = Path('/etc/openwebrx/antenna-switcher.json')
PORTS = ('Antenna A', 'Antenna B', 'Antenna C')
_lock = threading.RLock()
_log = logging.getLogger(__name__)


class AntennaError(Exception):
    pass


def _config():
    if not CONFIG_PATH.exists():
        # Not configured on this receiver: report "not supported" quietly.
        return {'devices': {}}
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
        if not isinstance(config, dict) or not isinstance(config.get('devices'), dict):
            raise ValueError('devices must be an object')
        if config.get('access', 'public') not in ('public', 'key'):
            raise ValueError('access must be public or key')
        return config
    except (OSError, ValueError) as exc:
        _log.warning('Cannot load antenna switcher configuration: %s', exc)
        raise AntennaError('Antenna switcher configuration is unavailable.') from exc


def _device_config(source, config):
    if source is None:
        return None
    device = config['devices'].get(source.getId())
    if device is None:
        return None
    if not isinstance(device, dict):
        raise AntennaError('Invalid antenna device configuration.')
    # Explicit device allowlist prevents this RSPdx port map reaching another SDR.
    if not hasattr(source, 'getDriver') or source.getDriver() != 'sdrplay':
        return None
    antennas = device.get('antennas')
    if not isinstance(antennas, list) or not 1 <= len(antennas) <= 3:
        raise AntennaError('Configure one to three antenna ports.')
    values = []
    for item in antennas:
        if not isinstance(item, dict) or item.get('value') not in PORTS:
            raise AntennaError('Invalid antenna port configuration.')
        if not isinstance(item.get('label'), str) or not 1 <= len(item['label']) <= 80:
            raise AntennaError('Antenna labels must contain 1 to 80 characters.')
        values.append(item['value'])
    if len(set(values)) != len(values):
        raise AntennaError('Antenna ports must be unique.')
    return device


def _source_ready(source):
    return (source is not None
            and getattr(source, 'monitor', None) is not None
            and getattr(source, 'controlSocket', None) is not None
            and source.isEnabled()
            and not source.isFailed())


def _state(source, config):
    device = _device_config(source, config)
    if device is None:
        return {'supported': False,
                'sdr_id': source.getId() if source else None}
    props = source.getProps()
    runtime = getattr(source, '_rsp_antenna_runtime', None)
    selected = props['antenna'] if 'antenna' in props else None
    return {
        'supported': True,
        'sdr_id': source.getId(),
        'antennas': device['antennas'],
        'selected': selected,
        'held': bool(runtime and 'antenna' in runtime['layer']),
        'ready': _source_ready(source),
        'access': config.get('access', 'public'),
        'hardware_confirmed': False,
    }


def _reply(client, state, error=None):
    value = dict(state)
    if error:
        value['error'] = error
    client.send({'type': 'rsp_antenna_state', 'value': value})


def _broadcast(source, requester, state):
    clients = list(getattr(source, 'clients', []))
    if requester not in clients:
        clients.append(requester)
    for client in clients:
        if getattr(client, 'sdr', None) is source and hasattr(client, 'send'):
            try:
                _reply(client, state)
            except Exception:
                _log.debug('Could not update an antenna client', exc_info=True)


def handle_antenna_message(client, message):
    """Called only for getantenna/setantenna receiver WebSocket messages."""
    source = getattr(client, 'sdr', None)
    state = {'supported': False,
             'sdr_id': source.getId() if source else None}
    try:
        with _lock:
            config = _config()
            state = _state(source, config)
            if message.get('type') == 'getantenna':
                _reply(client, state)
                return
            if not state['supported']:
                raise AntennaError('Antenna switching is not enabled for this receiver.')
            params = message.get('params')
            if not isinstance(params, dict):
                raise AntennaError('Invalid antenna request.')
            if params.get('sdr_id') != source.getId():
                raise AntennaError('The receiver changed. Try again.')
            if config.get('access', 'public') == 'key':
                magic = client.stack['magic_key'] if 'magic_key' in client.stack else ''
                if not magic or params.get('key') != magic:
                    raise AntennaError('Enter the receiver Magic Key in Settings first.')
            selected = params.get('antenna')
            if selected not in [p['value'] for p in state['antennas']]:
                raise AntennaError('That antenna port is not enabled.')
            if not _source_ready(source):
                raise AntennaError('The SDR is not running. Wait and try again.')
            runtime = getattr(source, '_rsp_antenna_runtime', None)
            # A per-source cooldown applies to every client, including new connections.
            if runtime and selected != state['selected']:
                if time.monotonic() - runtime['last_change'] < 2:
                    raise AntennaError('Wait two seconds between antenna changes.')
            if runtime is None:
                # Negative priority keeps the choice above the active profile.
                # Never assign source.props['antenna'] directly: that can edit a profile.
                layer = PropertyLayer()
                source.getProps().addLayer(-10, layer)
                runtime = {'layer': layer, 'last_change': float('-inf')}
                source._rsp_antenna_runtime = runtime
            if ('antenna' not in runtime['layer']
                    or runtime['layer']['antenna'] != selected):
                runtime['layer']['antenna'] = selected
                runtime['last_change'] = time.monotonic()
                _log.info('Receiver %s: selected %s (shared runtime override)',
                          source.getId(), selected)
            state = _state(source, config)
            _broadcast(source, client, state)
    except AntennaError as exc:
        _reply(client, state, str(exc))
    except Exception:
        _log.exception('Antenna switch request failed')
        _reply(client, state, 'Could not change the antenna. Check the server log.')
