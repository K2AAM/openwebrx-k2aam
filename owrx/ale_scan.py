"""Receive-only ALE background scanner; no browser owns its lifetime."""
from collections import deque
import hmac
import json
import logging
import math
from pathlib import Path
import threading
import time
import uuid
from owrx.ale_log import get_log

logger = logging.getLogger(__name__)


def native_chain(source, frequency, callback):
    from csdr.chain.analog import Ssb
    from csdr.chain.ale import AleDemodulator
    from owrx.service.chain import ServiceDemodulatorChain
    from pycsdr.modules import Buffer
    secondary = None
    chain = None
    try:
        secondary = AleDemodulator(callback=callback)
        secondary.setDialFrequency(frequency)
        props = source.getProps()
        chain = ServiceDemodulatorChain(Ssb(), secondary, props['samp_rate'], frequency-props['center_freq'])
        chain.setBandPass(600, 2650)
        chain.setFrequency(frequency)
        chain.setMode('ale2g')
        # Keep the output buffer alive even though callback mode returns no messages.
        chain.ale_output = Buffer(chain.getOutputFormat())
        chain.setWriter(chain.ale_output)
        chain.setReader(source.getBuffer().getReader())
        return chain
    except Exception:
        if chain is not None:
            chain.stop()
        elif secondary is not None:
            secondary.stop()
        raise


def validate_options(options, catalog):
    bank = next((b for b in catalog['banks'] if b['id'] == options.get('bank')), None)
    if bank is None:
        raise ValueError('Unknown ALE bank')
    channels = options.get('channels')
    allowed = {c['frequency_hz'] for c in bank['channels']}
    if not isinstance(channels, list) or not channels or len(channels) > 45:
        raise ValueError('Select 1–45 bank channels')
    if any(type(f) is not int or f not in allowed for f in channels):
        raise ValueError('Channel is not in the selected bank')
    dwell = options.get('dwell', 10)
    if type(dwell) not in (int, float) or not math.isfinite(dwell) or not 3 <= dwell <= 60:
        raise ValueError('Dwell must be 3–60 seconds')
    across = options.get('across', False)
    if type(across) is not bool:
        raise ValueError('Invalid cross-band option')
    return {'bank':bank['id'], 'channels':list(dict.fromkeys(channels)), 'dwell':float(dwell), 'across':across}


def native_retune_allowed():
    from owrx.config import Config
    return bool(Config.get()['allow_center_freq_changes'])


def state_path():
    from owrx.config.core import CoreConfig
    return Path(CoreConfig().get_data_directory())/'ale-log'/'scan-state.json'


_state_lock = threading.Lock()
_shutting_down = False


def _update_saved(path, source_id, entry):
    """Record (entry) or forget (None) the scan to resume for one receiver."""
    if path is None:
        return
    try:
        path = path() if callable(path) else path
        with _state_lock:
            try:
                saved = json.loads(path.read_text())
                if not isinstance(saved, dict):
                    saved = {}
            except (OSError, ValueError):
                saved = {}
            if entry is None:
                if source_id not in saved:
                    return
                del saved[source_id]
            else:
                saved[source_id] = entry
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            temporary = path.with_name(path.name+'.tmp')
            temporary.write_text(json.dumps(saved))
            temporary.replace(path)
    except Exception:
        logger.exception('Cannot update saved ALE scan state')


# One decoder runs per watched channel, so a group is bounded for CPU's sake.
MAX_PARALLEL = 16
# Fraction of the capture trusted when planning a retune; the edges roll off.
USABLE = 0.9
# Identical decodes this close together are one reception with a repeat count.
REPEAT_WINDOW = 15


class ScanStopped(ValueError):
    """A condition retrying cannot fix; the scan ends."""


def passband_fits(frequency, center, rate, usable=1.0):
    half = rate*usable/2
    return center-half < frequency+600 and frequency+2650 < center+half


def choose_center(cluster, rate):
    """A dial frequency from the cluster as SDR center: its own carrier sits at
    0 Hz audio, outside every 600-2650 Hz decoder passband."""
    middle = (cluster[0]+600+cluster[-1]+2650)/2
    for candidate in sorted(cluster, key=lambda f: abs(f-middle)):
        if all(passband_fits(f, candidate, rate, USABLE) for f in cluster) and \
                not any(f+600 <= candidate <= f+2650 for f in cluster):
            return candidate
    return cluster[0] if len(cluster) == 1 else None


def plan_groups(channels, rate, center, across, parallel=MAX_PARALLEL):
    """Split channels into groups that are decoded simultaneously.

    Channels inside the current capture come first and need no retune. With
    across, the rest are clustered so each cluster fits one capture.
    """
    local = [f for f in channels if passband_fits(f, center, rate)]
    groups = [(center, local[i:i+parallel]) for i in range(0, len(local), parallel)]
    if across:
        cluster = []
        for frequency in sorted(f for f in channels if f not in local):
            if cluster and (len(cluster) >= parallel or choose_center(cluster+[frequency], rate) is None):
                groups.append((choose_center(cluster, rate), cluster))
                cluster = []
            cluster.append(frequency)
        if cluster:
            groups.append((choose_center(cluster, rate), cluster))
    return groups


class AleBackgroundScan:
    def __init__(self, source, factory=native_chain, clock=time.monotonic, settle=0.25, retune_allowed=native_retune_allowed,
                 journal=None, state=None, startup=10, retry_delays=(2, 5, 15, 30, 60)):
        # state: path (or callable returning one) of the resume file; None keeps nothing.
        self.state = state
        self.startup = startup
        self.retry_delays = tuple(retry_delays)
        self.source = source
        self.factory = factory
        self.clock = clock
        self.settle = settle
        self.retune_allowed = retune_allowed
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.thread = None
        self.history = deque(maxlen=250)
        self.sequence = 0
        self.session = uuid.uuid4().hex
        self.generation = 0
        self.running = False
        self.status = 'Stopped'
        self.frequency = None
        self.options = None
        self.groups = []
        self.chains = {}
        self.subscription = None
        self.active = set()
        self.hold_started = None
        self.release_at = 0
        self.deadline = 0
        self.expected_center = None
        self.profile = None
        self.rate = None
        self.index = -1
        self.reason = 'Stopped'
        self.journal = journal
        self.log_error = None
        self.last_key = None
        self.last_entry = None
        self.last_time = 0
        self.unique = 0
        try:
            if self.journal is None:
                self.journal = get_log()
            for message in self.journal.recent(source.getId()):
                self.sequence += 1
                self.history.append(dict(message, scan_seq=self.sequence, restored=True))
        except Exception:
            self.log_error = 'ALE log unavailable; check the server journal'
            logger.exception('Cannot restore ALE reception log')

    def getClientClass(self):
        from owrx.source import SdrClientClass
        # An explicitly started scan owns active RF use even with no browser.
        # BACKGROUND keeps the hardware on but leaves it IDLE to the native
        # service scheduler, which can otherwise replace the scan's profile.
        return SdrClientClass.USER

    def onStateChange(self, state):
        if getattr(state, 'name', '') in ('STOPPING', 'STOPPED') and self.chains:
            self.stop('Stopped: SDR stopped')

    def onBusyStateChange(self, state):
        pass

    def onFail(self):
        self.stop('Stopped: SDR failed')

    def onDisable(self):
        self.stop('Stopped: SDR disabled')

    def onShutdown(self):
        self.stop('Stopped: SDR shutting down')

    def onEnable(self):
        pass

    def properties_changed(self, changes):
        if not self.running:
            return
        if 'profile_id' in changes and changes['profile_id'] != self.profile:
            self.stop('Stopped: receiver profile changed')
        elif 'samp_rate' in changes and changes['samp_rate'] != self.rate:
            self.stop('Stopped: sample rate changed')
        elif 'center_freq' in changes and changes['center_freq'] != self.expected_center:
            self.stop('Stopped: SDR manually retuned')

    def start(self, options):
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                raise ValueError('Server scanner is already running or stopping')
            props = self.source.getProps()
            self.profile = props['profile_id']
            self.rate = props['samp_rate']
            self.expected_center = props['center_freq']
            self.options = options
            if not options['across']:
                channels = [f for f in options['channels'] if self.fits(f, self.expected_center)]
                if not channels:
                    raise ValueError('No selected channels fit the capture; enable Scan across HF bands')
                self.options = dict(options, channels=channels)
            self.groups = plan_groups(self.options['channels'], self.rate, self.expected_center, self.options['across'])
            if not self.groups or any(center is None for center, _ in self.groups):
                raise ValueError('Selected channels cannot be arranged for this SDR sample rate')
            self.index = -1
            self.frequency = None
            self.cancel.clear()
            self.running = True
            self.reason = 'Stopped'
            self.status = 'Server scanner starting…'
            logger.info('ALE server scanner starting: receiver=%s bank=%s channels=%s groups=%s dwell=%s across=%s',
                        self.source.getId(), self.options['bank'], len(self.options['channels']), len(self.groups),
                        self.options['dwell'], self.options['across'])
            # Saved with the options as requested, so a resumed scan re-derives its channel list.
            _update_saved(self.state, self.source.getId(), {'options': options, 'profile': self.profile})
            self.thread = threading.Thread(target=self.run, name='ALE-scan-'+self.source.getId(), daemon=True)
            self.thread.start()

    def stop(self, reason='Stopped'):
        # Source callbacks must never join a DSP/source thread while holding its lock.
        with self.lock:
            self.reason = reason
            self.cancel.set()
            if self.running:
                self.status = 'Stopping server scanner…'

    def fits(self, frequency, center):
        return passband_fits(frequency, center, self.rate)

    def hops(self):
        """True when the scan moves between groups rather than watching one."""
        return len(self.groups) > 1

    def retunes(self):
        return len({center for center, _ in self.groups}) > 1

    def event(self, generation, message):
        with self.lock:
            frequency = message.get('freq')
            if not self.running or self.cancel.is_set() or generation != self.generation or frequency not in self.chains:
                return
            if message.get('test_audio'):
                return
            now = self.clock()
            if message.get('event') == 'activity':
                if message['active']:
                    self.active.add(frequency)
                else:
                    self.active.discard(frequency)
                    if self.hold_started is None:
                        return
            if self.hold_started is None:
                self.hold_started = now
            self.release_at = now+3
            self.frequency = frequency
            self.status = ('Activity' if message.get('event') == 'activity' else 'Decoded') + \
                (' / hold' if self.hops() else '') + f' · {frequency/1000:.1f} kHz · server'
            if message.get('event') == 'activity':
                return
            key = (frequency, message.get('event'), message.get('source'), message.get('destination'), message.get('message'))
            if key == self.last_key and self.last_entry is not None and now-self.last_time <= REPEAT_WINDOW:
                # The same words again within one transmission: count, don't relog.
                entry = self.last_entry
                try:
                    self.history.remove(entry)
                except ValueError:
                    pass
                self.sequence += 1
                entry['repeats'] += 1
                entry['scan_seq'] = self.sequence
                entry['timestamp_last'] = message.get('timestamp')
                self.history.append(entry)
                self.last_time = now
                return
            self.sequence += 1
            self.unique += 1
            saved = dict(message, server_scan=True, scan_seq=self.sequence, repeats=1, uid=f'{self.session}-{self.unique}')
            try:
                if self.journal is None:
                    self.journal = get_log()
                saved['log_id'] = self.journal.append(self.source.getId(), self.options['bank'], message)
                self.log_error = None
            except Exception:
                if self.log_error is None:
                    logger.exception('Cannot save ALE reception log')
                self.log_error = 'ALE log unavailable; check the server journal'
            self.history.append(saved)
            self.last_key, self.last_entry, self.last_time = key, saved, now
            logger.info('ALE server decode: %s', json.dumps(saved))

    def ready_to_advance(self):
        if not self.hops():
            return False
        now = self.clock()
        if self.hold_started is not None:
            return now-self.hold_started >= 120 or (not self.active and now >= self.release_at)
        return now >= self.deadline

    def close_chains(self):
        with self.lock:
            self.generation += 1
            chains, self.chains = self.chains, {}
        for chain in chains.values():
            try:
                chain.stop()
            except Exception:
                logger.exception('ALE scanner DSP cleanup failed')

    def next_group(self):
        self.close_chains()
        with self.lock:
            if self.cancel.is_set():
                return
            self.index = (self.index+1) % len(self.groups)
            center, channels = self.groups[self.index]
            self.active = set()
            self.hold_started = None
            self.release_at = 0
            self.frequency = channels[0] if self.hops() else None
            self.status = f'Tuning {channels[0]/1000:.1f} kHz · server' if len(channels) == 1 else \
                f'Tuning {len(channels)} channels near {center/1e6:.3f} MHz · server'
            retune = self.source.getProps()['center_freq'] != center
            if retune:
                if not self.options['across']:
                    raise ScanStopped('Channel no longer fits the capture')
                self.expected_center = center
            generation = self.generation
        if retune:
            if not self.retune_allowed():
                raise ScanStopped('Server no longer allows SDR retuning')
            self.source.setCenterFreq(center)
            if self.cancel.wait(self.settle):
                return
        if self.cancel.is_set():
            return
        if self.source.getProps()['center_freq'] != self.expected_center:
            raise ValueError('SDR center did not settle at the requested frequency')
        chains = {}
        try:
            for frequency in channels:
                chains[frequency] = self.factory(self.source, frequency, lambda message: self.event(generation, message))
        except Exception:
            for chain in chains.values():
                chain.stop()
            raise
        with self.lock:
            if self.cancel.is_set() or generation != self.generation:
                stale, chains = chains, {}
            else:
                stale = {}
                self.chains = chains
                self.deadline = self.clock()+self.options['dwell']
                if self.hold_started is None:
                    count = len(channels)
                    what = f'{channels[0]/1000:.1f} kHz' if count == 1 else f'{count} channels'
                    self.status = (f'Scanning {self.index+1}/{len(self.groups)} · {what} · server' if self.hops()
                                   else f'Watching {what} · server')
        for chain in stale.values():
            chain.stop()

    def run(self):
        attached = False
        try:
            self.source.addClient(self)
            attached = True
            self.subscription = self.source.getProps().wire(self.properties_changed)
            deadline = self.clock()+self.startup
            while getattr(self.source.getState(), 'name', '') != 'RUNNING':
                if self.cancel.wait(0.1):
                    return
                if self.clock() >= deadline:
                    raise ValueError('SDR startup timed out')
            attempt = 0
            advance = True
            while not self.cancel.is_set():
                if advance:
                    try:
                        self.next_group()
                        attempt = 0
                    except ScanStopped:
                        raise
                    except Exception as error:
                        # A brief SDR or DSP hiccup: try the same group again, a few times.
                        if attempt >= len(self.retry_delays):
                            raise
                        delay = self.retry_delays[attempt]
                        attempt += 1
                        self.close_chains()
                        with self.lock:
                            self.index -= 1
                            self.status = f'Retrying in {delay:g} s: {error}'
                        logger.warning('ALE server scanner retry %s/%s for %s: %s', attempt, len(self.retry_delays),
                                       self.source.getId(), error)
                        if self.cancel.wait(delay):
                            return
                        continue
                if self.cancel.wait(0.05):
                    break
                with self.lock:
                    advance = self.ready_to_advance()
        except Exception as error:
            self.reason = 'Stopped: '+str(error)
            logger.exception('ALE background scanner failed')
        finally:
            self.cancel.set()
            try:
                self.close_chains()
            except Exception:
                logger.exception('ALE scanner DSP cleanup failed')
            try:
                if self.subscription is not None:
                    self.subscription.cancel()
                    self.subscription = None
                if attached:
                    self.source.removeClient(self)
            except Exception:
                logger.exception('ALE scanner source cleanup failed')
            finally:
                with self.lock:
                    self.running = False
                    self.status = self.reason
                # A scan that ends for any reason other than service shutdown is not resumed.
                if not _shutting_down:
                    _update_saved(self.state, self.source.getId(), None)
                logger.info('ALE server scanner stopped: receiver=%s reason=%s', self.source.getId(), self.reason)

    def snapshot(self, after=0):
        with self.lock:
            watching = list(self.groups[self.index][1]) if self.running and 0 <= self.index < len(self.groups) else []
            return {'available':True, 'session':self.session, 'running':self.running,
                    'stopping':self.running and self.cancel.is_set(),
                    'status':self.status, 'frequency':self.frequency, 'bank':self.options['bank'] if self.options else None,
                    'watching':watching, 'groups':len(self.groups), 'hops':self.running and self.hops(),
                    'retunes':self.running and self.retunes(),
                    'sequence':self.sequence, 'events':[e.copy() for e in self.history if e['scan_seq'] > after],
                    'options':self.options, 'source_id':self.source.getId(), 'log_error':self.log_error}


_registry = {}
_registry_lock = threading.Lock()


def check_control(client, params):
    """Starting or stopping a scan takes over the SDR for every listener.

    Unless the operator sets ale_scan_public, it needs the receiver magic
    key, and an empty magic key locks scanner control instead of opening it.
    """
    stack = client.stack
    if 'ale_scan_public' in stack and stack['ale_scan_public'] is True:
        return
    magic = stack['magic_key'] if 'magic_key' in stack else ''
    if not isinstance(magic, str) or not magic:
        raise ValueError('Scanner control is locked: set a receiver magic key, or allow public ALE scanner control in the settings')
    key = params.get('key')
    if not isinstance(key, str) or not hmac.compare_digest(key.encode(), magic.encode()):
        raise ValueError('Scanner control requires the receiver magic key')


def prepare_shutdown():
    """Called before the service stops its SDRs, so running scans stay saved for resume."""
    global _shutting_down
    _shutting_down = True


def resume_saved(delay=5, path=state_path, sources=None, features=None, catalog=None, start=True):
    """Restart scans that were running when the service last stopped. Never raises."""
    def work():
        resumed = []
        try:
            file = path() if callable(path) else path
            if not file.exists():
                return resumed
            saved = json.loads(file.read_text())
            if not isinstance(saved, dict) or not saved:
                return resumed
            if features is None:
                from owrx.feature import FeatureDetector
                available = FeatureDetector().is_available('ale2g')
            else:
                available = features()
            if not available:
                logger.warning('Saved ALE scan not resumed: the owrx-ale decoder is unavailable')
                return resumed
            if sources is None:
                from owrx.sdr import SdrService
                lookup = SdrService.getSource
            else:
                lookup = sources
            banks = catalog if catalog is not None else json.loads(Path(__file__).with_name('ale_channels.json').read_text())
            for source_id, entry in saved.items():
                try:
                    source = lookup(source_id)
                    if source is None or not isinstance(entry, dict):
                        raise ValueError('receiver is not available')
                    options = validate_options(entry.get('options'), banks) if isinstance(entry.get('options'), dict) else None
                    if options is None:
                        raise ValueError('saved options are invalid')
                    if options['across'] and not native_retune_allowed():
                        raise ValueError('SDR retuning is no longer allowed')
                    profile = entry.get('profile')
                    if isinstance(profile, str) and source.getProfileId() != profile:
                        source.activateProfile(profile)
                        if source.getProfileId() != profile:
                            raise ValueError('saved profile no longer exists')
                    with _registry_lock:
                        scan = _registry.get(source_id)
                        if scan is None or scan.source is not source:
                            # SDR start-up can include a firmware upload; allow longer than an interactive start.
                            scan = _registry[source_id] = AleBackgroundScan(source, state=path, startup=45)
                    scan.start(options)
                    resumed.append(source_id)
                    logger.info('ALE server scanner resumed after restart: receiver=%s', source_id)
                except Exception as error:
                    logger.warning('Saved ALE scan for %s not resumed: %s', source_id, error)
                    _update_saved(path, source_id, None)
        except Exception:
            logger.exception('Cannot resume saved ALE scans')
        return resumed
    if not start:
        return work()
    timer = threading.Timer(delay, work)
    timer.daemon = True
    timer.name = 'ALE-scan-resume'
    timer.start()
    return timer


def request(client, params):
    if not isinstance(params, dict) or client.sdr is None:
        raise ValueError('No receiver selected')
    action = params.get('action', 'status')
    if action in ('log', 'export'):
        request_id = params.get('request_id')
        if not isinstance(request_id, str) or not request_id.isascii() or not request_id.isdigit() or len(request_id) > 12:
            raise ValueError('Invalid log request identifier')
        result = {'kind':'log', 'request_id':request_id, 'source_id':client.sdr.getId()}
        try:
            journal = get_log()
            if action == 'log':
                result.update(journal.summary(client.sdr.getId()))
            else:
                result.update(journal.page(client.sdr.getId(), params.get('log_after', 0), params.get('log_through')))
        except ValueError:
            result['error'] = 'Invalid ALE log request'
        except Exception:
            logger.exception('Cannot read ALE reception log')
            result['error'] = 'ALE log unavailable; check the server journal'
        return result
    if action not in ('start', 'stop', 'status'):
        raise ValueError('Unknown scanner action')
    after = params.get('after', 0)
    if type(after) is not int or not 0 <= after <= 2**53-1:
        raise ValueError('Invalid history cursor')
    if action != 'status':
        check_control(client, params)
    with _registry_lock:
        source_id = client.sdr.getId()
        scan = _registry.get(source_id)
        if scan is None or scan.source is not client.sdr:
            if scan is not None:
                scan.stop('Stopped: SDR replaced')
            scan = _registry[source_id] = AleBackgroundScan(client.sdr, state=state_path)
    if action == 'start':
        catalog = json.loads(Path(__file__).with_name('ale_channels.json').read_text())
        options = validate_options(params, catalog)
        if options['across'] and not client.stack['allow_center_freq_changes']:
            raise ValueError('Enable Allow center frequency changes in receiver settings')
        # Avoid two scanners consuming/retuning from the same source.
        scan.start(options)
    elif action == 'stop':
        scan.stop()
    return scan.snapshot(after)
