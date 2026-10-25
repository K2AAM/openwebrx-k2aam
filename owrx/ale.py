"""Receive-only ALE parser for native OWRX secondary-demodulator output."""
from datetime import datetime, timezone
from owrx.toolbox import TextParser
from owrx.ale_protocol import decode_event


class AleParser(TextParser):
    def __init__(self):
        super().__init__(filePrefix='ALE', service=False)

    def parse(self, msg: bytes):
        return decode_event(msg, self.frequency,
                            round(datetime.now(timezone.utc).timestamp() * 1000))
