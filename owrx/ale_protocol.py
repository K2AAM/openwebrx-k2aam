"""Validate receive-only ALE decoder events without SDR or UI dependencies."""
import json
import re

EVENTS = {'sounding_this_was', 'sounding_this_is', 'destination', 'call',
          'call_ack', 'call_established', 'amd', 'dtm', 'command'}


def decode_event(line: bytes, frequency: int, timestamp_ms: int):
    if len(line) > 4096:
        return {}
    try:
        event = json.loads(line)
    except (ValueError, UnicodeError):
        return {}
    if not isinstance(event, dict) or event.get('kind') not in ('decode', 'activity'):
        return {}
    # A process restart can leave queued output from the previous channel.
    # The decoder's own generation frequency prevents relabeling that output.
    if type(event.get('frequency_hz')) is not int or event['frequency_hz'] != frequency:
        return {}
    test_audio = event.get('test_audio', False) is True
    if event.get('kind') == 'activity':
        if type(event.get('active')) is not bool or frequency <= 0:
            return {}
        return {'mode': 'ALE2G', 'timestamp': timestamp_ms, 'freq': frequency,
                'event': 'activity', 'active': event['active'], 'test_audio': test_audio}
    if not isinstance(event.get('event'), str) or event['event'] not in EVENTS or frequency <= 0:
        return {}
    for key, limit in [('source', 255), ('destination', 255), ('display', 512)]:
        if not isinstance(event.get(key), str) or len(event[key]) > limit:
            return {}
    message = re.sub(r'^\[\d{2}:\d{2}:\d{2}\]\s*', '', event['display'])
    message = re.sub(r'\s*\[His BER: \d+\]$', '', message)
    return {'mode': 'ALE2G', 'timestamp': timestamp_ms, 'freq': frequency,
            'event': event['event'], 'test_audio': test_audio, 'source': event['source'],
            'destination': event['destination'], 'message': message}
