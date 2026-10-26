"""Bounded, durable reception history for the ALE server scanner."""
from contextlib import closing
from pathlib import Path
import sqlite3
import threading

from owrx.ale_protocol import EVENTS


class AleLog:
    LIMIT = 50000
    PAGE = 200

    def __init__(self, path, limit=LIMIT):
        if type(limit) is not int or not 1 <= limit <= self.LIMIT:
            raise ValueError('Invalid ALE retention limit')
        self.path = Path(path)
        self.limit = limit
        self.lock = threading.RLock()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS receptions ('
                       'id INTEGER PRIMARY KEY AUTOINCREMENT, receiver TEXT NOT NULL, '
                       'timestamp INTEGER NOT NULL, freq INTEGER NOT NULL, source TEXT NOT NULL, '
                       'destination TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL, bank TEXT NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS ale_receiver_id ON receptions(receiver,id)')
            db.execute('CREATE INDEX IF NOT EXISTS ale_receiver_source ON receptions(receiver,source)')
            db.commit()

    def connect(self):
        return closing(sqlite3.connect(self.path, timeout=1))

    @staticmethod
    def unpack(row):
        return dict(zip(('log_id', 'source_id', 'timestamp', 'freq', 'source',
                         'destination', 'event', 'message', 'bank'), row),
                    mode='ALE2G', server_scan=True)

    def append(self, receiver, bank, event):
        if event.get('test_audio') or event.get('event') not in EVENTS:
            return None
        if not isinstance(receiver, str) or not 1 <= len(receiver) <= 255:
            raise ValueError('Invalid ALE receiver identifier')
        for key in ('timestamp', 'freq'):
            if type(event.get(key)) is not int or not 0 < event[key] <= 2**53-1:
                raise ValueError('Invalid ALE '+key)
        for key, size in (('source', 255), ('destination', 255), ('message', 512)):
            if not isinstance(event.get(key, ''), str) or len(event.get(key, '')) > size:
                raise ValueError('Invalid ALE '+key)
        if not isinstance(bank, str) or len(bank) > 255:
            raise ValueError('Invalid ALE bank')
        with self.lock, self.connect() as db, db:
            # Delete before inserting, so the retained row count never grows unbounded.
            db.execute('DELETE FROM receptions WHERE id <= '
                       '(SELECT id FROM receptions ORDER BY id DESC LIMIT 1 OFFSET ?)', (self.limit-1,))
            result = db.execute('INSERT INTO receptions '
                                '(receiver,timestamp,freq,source,destination,event,message,bank) '
                                'VALUES (?,?,?,?,?,?,?,?)',
                                (receiver, event['timestamp'], event['freq'], event.get('source', ''),
                                 event.get('destination', ''), event['event'], event.get('message', ''), bank))
            return result.lastrowid

    def recent(self, receiver):
        with self.lock, self.connect() as db:
            rows = db.execute('SELECT * FROM receptions WHERE receiver=? ORDER BY id DESC LIMIT 250',
                              (receiver,)).fetchall()
            return [self.unpack(row) for row in reversed(rows)]

    def summary(self, receiver):
        with self.lock, self.connect() as db:
            total, revision = db.execute('SELECT COUNT(*),COALESCE(MAX(id),0) FROM receptions WHERE receiver=?',
                                         (receiver,)).fetchone()
            # A received source address is evidence; a destination alone is not a heard station.
            rows = db.execute('SELECT source,MAX(timestamp),COUNT(*) FROM receptions '
                              "WHERE receiver=? AND source<>'' GROUP BY source "
                              'ORDER BY MAX(timestamp) DESC,source LIMIT 50', (receiver,)).fetchall()
            stations = []
            for address, timestamp, count in rows:
                frequencies = db.execute('SELECT DISTINCT freq FROM receptions WHERE receiver=? AND source=? '
                                         'ORDER BY freq LIMIT 45', (receiver, address)).fetchall()
                stations.append({'address':address, 'timestamp':timestamp, 'count':count,
                                 'frequencies':[row[0] for row in frequencies]})
            return {'total':total, 'revision':revision, 'retention':self.limit,
                    'stations':stations, 'station_limit':50}

    def page(self, receiver, after=0, through=None):
        if type(after) is not int or not 0 <= after <= 2**53-1:
            raise ValueError('Invalid log cursor')
        if through is not None and (type(through) is not int or not 0 <= through <= 2**53-1):
            raise ValueError('Invalid log end cursor')
        with self.lock, self.connect() as db:
            if through is None:
                through = db.execute('SELECT COALESCE(MAX(id),0) FROM receptions WHERE receiver=?',
                                     (receiver,)).fetchone()[0]
            rows = db.execute('SELECT * FROM receptions WHERE receiver=? AND id>? AND id<=? '
                              'ORDER BY id LIMIT ?', (receiver, after, through, self.PAGE+1)).fetchall()
            events = [self.unpack(row) for row in rows[:self.PAGE]]
            total = db.execute('SELECT COUNT(*) FROM receptions WHERE receiver=? AND id<=?',
                               (receiver, through)).fetchone()[0]
            return {'events':events, 'through':through, 'after':events[-1]['log_id'] if events else after,
                    'more':len(rows) > self.PAGE, 'total':total}


_instance = None
_lock = threading.Lock()


def get_log():
    global _instance
    with _lock:
        if _instance is None:
            from owrx.config.core import CoreConfig
            _instance = AleLog(Path(CoreConfig().get_data_directory())/'ale-log'/'receptions.sqlite3')
        return _instance
